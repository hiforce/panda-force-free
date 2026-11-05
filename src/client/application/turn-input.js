import { NO_ACTIVE_TURN, THREAD_NOT_FOUND, bridgeErrorCode } from "../../shared/bridge-errors.js";

// Only definitive native rejections permit retrying or starting a fresh turn.
// A transport timeout may have committed the mutation and must propagate.
export async function steerOrStart({
  rpc,
  resume,
  thread,
  turnId,
  input,
  clientUserMessageId,
  startOptions,
  onDispatch,
  onNoActiveTurn,
}) {
  const prepared = thread.canAcceptDirectInput !== true;
  const steer = () => {
    onDispatch(true);
    return rpc("turn/steer", {
      threadId: thread.id,
      ...(prepared ? { pandaPrepareInput: true } : {}),
      expectedTurnId: turnId,
      input,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
  };
  try {
    try {
      return await steer();
    } catch (error) {
      if (prepared || bridgeErrorCode(error) !== THREAD_NOT_FOUND) throw error;
      onDispatch(false);
      await resume(thread);
      return await steer();
    }
  } catch (error) {
    if (bridgeErrorCode(error) !== NO_ACTIVE_TURN) throw error;
    onNoActiveTurn();
    return rpc("turn/start", {
      threadId: thread.id,
      ...(prepared ? { pandaPrepareInput: true } : {}),
      input,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...startOptions,
    });
  }
}
