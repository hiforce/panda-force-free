/** Transport-neutral request identity and opaque adapter payloads. */
export type RpcId = string | number;
export type RpcRecord = Record<string, unknown>;
export type RpcRequest = (method: string, params?: RpcRecord) => Promise<unknown>;
