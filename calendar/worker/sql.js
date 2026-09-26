// Splitting a schema file on a bare ";" is wrong: a semicolon inside a column
// comment cuts the CREATE TABLE in half, and D1 reports the half as "incomplete
// input" -- which takes the whole calendar down on the next cold start. Strip
// comments and skip semicolons inside string literals instead.
export function sqlStatements(text) {
  const out = [];
  let cur = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;      // drop the comment, keep the newline
      continue;
    }
    if (text[i] === "'") {
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }   // escaped quote
        if (text[i] === "'") { i++; break; }
        i++;
      }
      cur += text.slice(start, i);
      continue;
    }
    if (text[i] === ';') { out.push(cur); cur = ''; i++; continue; }
    cur += text[i];
    i++;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
