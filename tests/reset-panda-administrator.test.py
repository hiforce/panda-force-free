import importlib.util
import json
import tempfile
import unittest
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("panda_reset", Path(__file__).resolve().parents[1] / "deploy/spark/reset-panda-administrator.py")
reset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reset)


class AdministratorResetTest(unittest.TestCase):
    def fixture(self, base):
        root = base / "state"
        root.mkdir(mode=0o700)
        auth = root / ".panda"
        auth.mkdir(mode=0o700)
        record = auth / "administrator.json"
        record.write_text(json.dumps({"version": 1, "role": "admin", "username": "owner", "password": {"algorithm": "scrypt", "hash": "test"}}))
        record.chmod(0o600)
        return root, auth, record

    def test_only_the_administrator_record_is_archived(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, auth, record = self.fixture(base)
            project = base / "project.txt"
            project.write_text("keep project data")
            session = root / "session.json"
            session.write_text("keep session data")
            original = record.read_bytes()
            result = reset.reset_administrator(root)
            self.assertFalse(record.exists())
            self.assertEqual(Path(result["backupFile"]).read_bytes(), original)
            self.assertEqual(project.read_text(), "keep project data")
            self.assertEqual(session.read_text(), "keep session data")
            self.assertEqual(reset.reset_administrator(root)["action"], "already-uninitialized")

    def test_symlinked_record_is_rejected_without_touching_its_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, auth, record = self.fixture(base)
            other = base / "other.json"
            record.rename(other)
            record.symlink_to(other)
            with self.assertRaises(RuntimeError):
                reset.reset_administrator(root)
            self.assertTrue(other.exists())
            self.assertTrue(record.is_symlink())
            self.assertFalse((auth / "backups").exists())

    def test_legacy_credentials_are_rejected_before_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, auth, record = self.fixture(Path(tmp))
            (auth / "legacy-password.json").write_text("existing credential")
            with self.assertRaises(RuntimeError):
                reset.reset_administrator(root)
            self.assertTrue(record.exists())
            self.assertFalse((auth / "backups").exists())

    def test_linked_backup_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, auth, record = self.fixture(base)
            other = base / "unrelated"
            other.mkdir(mode=0o700)
            (auth / "backups").symlink_to(other)
            with self.assertRaises(RuntimeError):
                reset.reset_administrator(root)
            self.assertTrue(record.exists())
            self.assertEqual(list(other.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
