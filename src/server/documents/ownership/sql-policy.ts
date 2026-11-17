/** Only owned internal query aliases are accepted; document or model text never contributes SQL. */
export const sqliteOwnershipVisible = (alias: "d" | "documents") =>
  `NOT EXISTS(SELECT 1 FROM document_ownership_records o WHERE o.documentId=${alias}.id AND o.spaceId=${alias}.spaceId AND json_extract(o.record,'$.kind')<>'active')`;
export const mysqlOwnershipVisible = (alias: "d" | "panda_force_documents") =>
  `NOT EXISTS(SELECT 1 FROM panda_force_document_ownership_records o WHERE o.documentId=${alias}.id AND o.spaceId=${alias}.spaceId AND JSON_UNQUOTE(JSON_EXTRACT(o.record,'$.kind'))<>'active')`;
