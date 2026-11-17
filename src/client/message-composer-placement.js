/** Keep the one native input outside timeline content before navigation clears that content. */
export function parkMessageComposer({ blur = false } = {}) {
  const dock = document.querySelector(".composer-dock"),
    conversation = document.querySelector("#conversation"),
    shell = document.querySelector(".conversation-shell"),
    active = document.activeElement;
  if (!dock || !conversation || !shell) return;
  if (blur && active instanceof HTMLElement && dock.contains(active)) active.blur();
  if (conversation.contains(dock)) shell.append(dock);
}
