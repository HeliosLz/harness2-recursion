/**
 * Shared Gate-B verification surface (PR-4.1).
 *
 * Both `harness2-eval` and `harness2-apply` import this module so report
 * statistics, schema checks and hashing cannot drift. It is standalone and does
 * not import task/meta plugin sources.
 */
export {
  ARMS,
  EVAL_SCHEMA,
  PREREG_SCHEMA,
  buildReport,
  evaluateVerdict,
  hashOf,
  loadPrereg,
  loadTasks,
  replayReport,
  reportHash,
  stableStringify,
  validateFoldTaskSet,
  validatePrereg,
  validateReport,
} from './lib.mjs'
