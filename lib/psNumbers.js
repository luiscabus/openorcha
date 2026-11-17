// Parsing numbers out of `ps`.
//
// ps formats its floats in the machine's locale, so on a machine set to a
// language that writes decimals with a comma, `pcpu` comes back as "0,4", not
// "0.4". Every pattern here used to require a dot, which meant no agent was
// ever detected on such a machine — and the supervisor, using the same parse,
// kept concluding its agents had died and relaunching them.

// Matches a ps float in either convention.
const PS_FLOAT = '[\\d]+(?:[.,][\\d]+)?';

/** parseFloat that accepts a comma decimal separator. */
function psFloat(value) {
  const n = parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * One line of `ps -eo pid,pcpu,pmem,tty,etime,args`.
 * Returns { pid, cpu, mem, tty, etime, args } or null.
 */
function parsePsLine(line) {
  const m = String(line).match(new RegExp(`^\\s*(\\d+)\\s+(${PS_FLOAT})\\s+(${PS_FLOAT})\\s+(\\S+)\\s+(\\S+)\\s+(.*)$`));
  if (!m) return null;
  const [, pid, cpu, mem, tty, etime, args] = m;
  return { pid, cpu: psFloat(cpu), mem: psFloat(mem), tty, etime, args };
}

/** One line of the narrower `ps -eo pid,pcpu,tty,args`. */
function parsePsLineShort(line) {
  const m = String(line).match(new RegExp(`^\\s*(\\d+)\\s+(${PS_FLOAT})\\s+(\\S+)\\s+(.*)$`));
  if (!m) return null;
  const [, pid, cpu, tty, args] = m;
  return { pid, cpu: psFloat(cpu), tty, args };
}

/** `ps -p <pid> -o pcpu=,pmem=,etime=` */
function parsePsStats(text) {
  const m = String(text).trim().match(new RegExp(`^(${PS_FLOAT})\\s+(${PS_FLOAT})\\s+(\\S+)`));
  if (!m) return null;
  return { cpu: psFloat(m[1]), mem: psFloat(m[2]), etime: m[3] };
}

module.exports = { PS_FLOAT, psFloat, parsePsLine, parsePsLineShort, parsePsStats };
