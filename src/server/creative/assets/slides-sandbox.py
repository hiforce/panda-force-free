"""Run exactly one reviewed Office preview command with private files and no network."""
import ctypes
import errno
import os
from pathlib import Path
import re
import resource
import shutil
import sys

# Landlock syscall numbers shared by the supported Linux x86_64 and aarch64 bases.
CREATE_RULESET, ADD_RULE, RESTRICT_SELF = 444, 445, 446
EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1, 2, 4, 8
MAKE_CHAR, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM = (1 << n for n in (6, 9, 10, 11, 12))
TRUNCATE = 1 << 14
FILESYSTEM_RIGHTS = (TRUNCATE << 1) - 1
READ_TREE = EXECUTE | READ_FILE | READ_DIR
SCRATCH = FILESYSTEM_RIGHTS & ~(EXECUTE | MAKE_CHAR | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM)


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def checked(result):
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return result


def restrict_files(work, office):
    libc = ctypes.CDLL(None, use_errno=True)
    abi = checked(libc.syscall(CREATE_RULESET, None, 0, 1))
    if abi < 3:
        raise RuntimeError("preview filesystem isolation is unavailable")
    rules = Ruleset(FILESYSTEM_RIGHTS)
    ruleset = checked(libc.syscall(CREATE_RULESET, ctypes.byref(rules), ctypes.sizeof(rules), 0))
    try:
        trees = {Path(name).resolve() for name in ("/usr", "/lib", "/lib64", "/etc/fonts", "/etc/libreoffice")}
        if office and office.is_relative_to("/opt"):
            trees.add(office.parent)
        entries = [(path, READ_TREE) for path in trees if path.is_dir()]
        entries.extend((Path(path).resolve(), READ_FILE) for path in (
            "/etc/ld.so.cache", "/etc/localtime", "/etc/os-release", "/etc/locale.alias",
            "/usr/share/locale/locale.alias", "/etc/nsswitch.conf", "/etc/passwd",
            "/dev/urandom", "/dev/random",
        ) if Path(path).exists())
        entries += [(Path("/dev/null"), READ_FILE | WRITE_FILE), (work, SCRATCH)]
        for path, rights in entries:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathRule(rights, fd)
                checked(libc.syscall(ADD_RULE, ruleset, 1, ctypes.byref(rule), 0))
            finally:
                os.close(fd)
        checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
        checked(libc.syscall(RESTRICT_SELF, ruleset, 0))
    finally:
        os.close(ruleset)


def restrict_system_calls():
    lib = ctypes.CDLL("libseccomp.so.2")
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    rules = lib.seccomp_init(0x7FFF0000)  # Allow ordinary isolated file and CPU operations.
    if not rules:
        raise RuntimeError("preview system call isolation is unavailable")
    try:
        for name in (
            "socket", "socketcall", "connect", "bind", "sendto", "sendmsg", "sendmmsg",
            "io_uring_setup", "ptrace", "process_vm_readv", "process_vm_writev",
            "pidfd_getfd", "pidfd_send_signal", "kill", "tkill", "tgkill",
            "semget", "msgget", "shmget", "setsid", "setpgid",
        ):
            number = lib.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and lib.seccomp_rule_add(rules, 0x00050000 | errno.EPERM, number, 0):
                raise RuntimeError("could not install a preview rule")
        if lib.seccomp_load(rules):
            raise RuntimeError("could not restrict preview system calls")
    finally:
        lib.seccomp_release(rules)


# Only the stable prefixes of the LibreOfficeKit vtables are needed for PDF export.
KitPointer = ctypes.c_void_p
Destroy = ctypes.CFUNCTYPE(None, KitPointer)
Load = ctypes.CFUNCTYPE(KitPointer, KitPointer, ctypes.c_char_p)
Save = ctypes.CFUNCTYPE(ctypes.c_int, KitPointer, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p)


class OfficeApi(ctypes.Structure):
    _fields_ = [("size", ctypes.c_size_t), ("destroy", Destroy), ("load", Load)]


class DocumentApi(ctypes.Structure):
    _fields_ = [("size", ctypes.c_size_t), ("destroy", Destroy), ("save", Save)]


def api(pointer, kind):
    if not pointer:
        raise RuntimeError("could not initialize Office preview")
    table = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(kind))).contents.contents
    if table.size < ctypes.sizeof(kind):
        raise RuntimeError("Office preview interface is unavailable")
    return table


def convert(program, profile, source, target):
    library = next((program / name for name in ("libsofficeapp.so", "libmergedlo.so")
                    if (program / name).is_file()), None)
    if library is None:
        raise RuntimeError("Office preview library is unavailable")
    init = ctypes.CDLL(str(library), mode=ctypes.RTLD_GLOBAL).libreofficekit_hook_2
    init.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    init.restype = KitPointer
    office = init(os.fsencode(program), profile)
    actions = api(office, OfficeApi)
    document = actions.load(office, source)
    presentation = api(document, DocumentApi)
    try:
        options = b'{"ExportHiddenSlides":{"type":"boolean","value":"true"},"ExportBookmarks":{"type":"boolean","value":"false"}}'
        if not presentation.save(document, target, b"pdf", options):
            raise RuntimeError("could not export Office preview")
    finally:
        presentation.destroy(document)
    # The one-shot process owns the office instance and ends after its synchronous export.
    os._exit(0)


def main():
    work = Path.cwd().resolve()
    mode = sys.argv[1]
    office = None
    uris = ()
    if mode == "convert":
        command, args = "soffice", []
    elif mode == "info":
        command, args = "pdfinfo", [str(work / "preview.pdf")]
    elif mode == "page" and re.fullmatch(r"[1-9][0-9]{0,2}", sys.argv[2]):
        command = "pdftoppm"
        args = ["-f", sys.argv[2], "-l", sys.argv[2], "-singlefile", "-scale-to", "1440",
                "-png", str(work / "preview.pdf"), str(work / "page")]
    else:
        raise RuntimeError("invalid preview command")
    program = Path(shutil.which(command) or "").resolve(strict=True)
    if not program.is_file() or not (program.is_relative_to("/usr") or program.is_relative_to("/opt")):
        raise RuntimeError("reviewed preview command is unavailable")
    if mode == "convert":
        office = program.parent
        uris = tuple((work / name).as_uri().encode() for name in ("profile", "preview.pptx", "preview.pdf"))
        os.environ["SAL_USE_VCLPLUGIN"] = "svp"
        extensions = work / "extensions"
        (extensions / "cache" / "uno_packages").mkdir(parents=True)
        os.environ["UNO_SHARED_PACKAGES"] = extensions.as_uri()
        os.environ["UNO_SHARED_PACKAGES_CACHE"] = (extensions / "cache").as_uri()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (25, 26))
    resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024,) * 2)
    restrict_system_calls()
    restrict_files(work, office)
    if office:
        convert(office, *uris)
    else:
        os.execv(program, [str(program), *args])


if __name__ == "__main__":
    main()
