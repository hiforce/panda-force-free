import { NativeThemeError } from "../../../shared/templates/native/contracts.js";
import { CommandScope } from "../../../shared/packages/runtime/commands.js";

/** Site themes share process admission and drain while retaining domain-specific errors. */
export class NativeThemeOperations extends CommandScope {
  constructor() {
    super((code) => new NativeThemeError(code));
  }
}
