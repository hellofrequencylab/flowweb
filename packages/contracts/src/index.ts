export const PACKAGE = '@fw/contracts';

export type * from './generated/index.ts';
export {
  createValidator,
  DEFAULT_SCHEMA_DIR,
  SCHEMA_IDS,
  type SchemaId,
  UnknownSchemaError,
  type ValidationError,
  type ValidationResult,
  type Validator,
  validate,
} from './validate.ts';
