/** Narrow query capability omits mutation and lifecycle methods; snapshot adapters additionally enforce read-only SQL. */
/** Match the driver's tuple normalization without widening the constrained binding values or result rows. */
export type ReadArguments<Parameters> = Parameters extends any[] ? Parameters : [Parameters];
export interface ReadStatement<Row, Parameters extends (string | number | null)[]> {
  get(...values: Parameters): Row | null;
  all(...values: Parameters): Row[];
  iterate(...values: Parameters): IterableIterator<Row>;
}
export interface ReadQueries {
  query<Row = unknown, Parameters extends (string | number | null)[] = (string | number | null)[]>(
    sql: string,
  ): ReadStatement<Row, ReadArguments<Parameters>>;
}
