// node:sqlite is still marked experimental; the warning is noise in the service log. Imported first, before the database.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if ((typeof w === 'string' ? w : w.message).includes('SQLite is an experimental feature')) return;
  (emitWarning as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;
