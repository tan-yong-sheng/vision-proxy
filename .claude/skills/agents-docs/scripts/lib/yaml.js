// YAML subset: parse + serialize (zero deps, deterministic).
// Extracted from docs.js with zero behavior change.

export function parseValue(text) {
  text = text.trim();
  if (text === "") return null;
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner, ",").map((s) => parseScalar(s.trim()));
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const inner = text.slice(1, -1).trim();
    const o = {};
    if (inner !== "") {
      for (const part of splitTopLevel(inner, ",")) {
        const idx = part.indexOf(":");
        if (idx === -1) throw new Error(`bad inline map entry: ${part}`);
        o[part.slice(0, idx).trim()] = parseScalar(part.slice(idx + 1).trim());
      }
    }
    return o;
  }
  return parseScalar(text);
}

export function parseScalar(s) {
  s = s.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.length >= 2 && (s[0] === '"' && s.endsWith('"') || s[0] === "'" && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

export function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") depth++;
    if (ch === "]" || ch === "}" || ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

export function parseYaml(src) {
  const lines = src.split("\n");
  let i = 0;
  const peek = () => lines[i];
  const skipBlank = () => {
    while (i < lines.length && lines[i].trim() === "") i++;
  };
  const indentOf = (line) => /^(\s*)/.exec(line)[1].length;

  function node(minIndent) {
    skipBlank();
    if (i >= lines.length) return null;
    const line = peek();
    const ind = indentOf(line);
    if (ind < minIndent) return null;
    const body = line.trim();
    if (body.startsWith("-")) return list(ind);
    if (/^[\w.-]+:/.test(body)) return map(ind);
    i++;
    return parseScalar(body);
  }

  function map(ind) {
    const o = {};
    while (true) {
      skipBlank();
      if (i >= lines.length) break;
      const line = peek();
      const ind2 = indentOf(line);
      if (ind2 < ind) break;
      if (ind2 > ind) throw new Error(`bad indent: ${line}`);
      const body = line.trim();
      const m = /^([\w.-]+):\s*(.*)$/.exec(body);
      if (!m) throw new Error(`expected key: value - ${line}`);
      const key = m[1];
      const rest = m[2].trim();
      i++;
      if (rest === "" || rest === "|" || rest === ">") {
        skipBlank();
        if (i < lines.length && indentOf(peek()) > ind && peek().trim().startsWith("-")) {
          o[key] = list(indentOf(peek()));
        } else if (i < lines.length && indentOf(peek()) > ind) {
          o[key] = map(indentOf(peek()));
        } else {
          o[key] = null;
        }
      } else {
        o[key] = parseValue(rest);
      }
    }
    return o;
  }

  function list(ind) {
    const arr = [];
    while (true) {
      skipBlank();
      if (i >= lines.length) break;
      const line = peek();
      const ind2 = indentOf(line);
      if (ind2 < ind) break;
      if (ind2 > ind) throw new Error(`bad indent in list: ${line}`);
      const body = line.trim();
      if (!body.startsWith("- ")) break;
      const itemRest = body.slice(2).trim();
      i++;
      if (itemRest === "") {
        skipBlank();
        if (i < lines.length && indentOf(peek()) > ind) {
          if (peek().trim().startsWith("-")) arr.push(list(indentOf(peek())));
          else arr.push(map(indentOf(peek())));
        } else {
          arr.push(null);
        }
        continue;
      }
      const m = /^([\w.-]+):\s*(.*)$/.exec(itemRest);
      if (m) {
        const o = { [m[1]]: parseValue(m[2]) };
        while (i < lines.length && indentOf(peek()) === ind + 2) {
          const cm = /^([\w.-]+):\s*(.*)$/.exec(peek().trim());
          if (!cm) break;
          o[cm[1]] = parseValue(cm[2]);
          i++;
        }
        arr.push(o);
      } else {
        arr.push(parseValue(itemRest));
      }
    }
    return arr;
  }

  const v = node(0);
  if (v === null) return {};
  return typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function scalarStr(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (s === "") return '""';
  if (/[:#\[\]{},&*!|>'"%@`]|^\s|^[-?]|^\d/.test(s)) return JSON.stringify(s);
  return s;
}

export function valueStr(v) {
  if (Array.isArray(v)) return `[${v.map((x) => scalarStr(x)).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${k}: ${scalarStr(x)}`).join(", ")}}`;
  }
  return scalarStr(v);
}

export function emit(lines, key, value, ind) {
  const pad = " ".repeat(ind);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}${key}: []`);
      return;
    }
    const inlineable = value.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x));
    if (inlineable && JSON.stringify(value).length <= 70) {
      lines.push(`${pad}${key}: [${value.map((x) => scalarStr(x)).join(", ")}]`);
      return;
    }
    lines.push(`${pad}${key}:`);
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          lines.push(`${pad}  - {}`);
        } else {
          lines.push(`${pad}  - ${entries[0][0]}: ${valueStr(entries[0][1])}`);
          for (const [ek, ev] of entries.slice(1)) lines.push(`${pad}    ${ek}: ${valueStr(ev)}`);
        }
      } else {
        lines.push(`${pad}  - ${valueStr(item)}`);
      }
    }
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      lines.push(`${pad}${key}: {}`);
      return;
    }
    if (entries.length <= 4 && JSON.stringify(value).length <= 90) {
      lines.push(`${pad}${key}: {${entries.map(([k, v]) => `${k}: ${valueStr(v)}`).join(", ")}}`);
      return;
    }
    lines.push(`${pad}${key}:`);
    for (const [k, v] of entries) emit(lines, k, v, ind + 2);
  } else {
    lines.push(`${pad}${key}: ${valueStr(value)}`);
  }
}

export function serializeYaml(o) {
  const lines = [];
  for (const [k, v] of Object.entries(o)) emit(lines, k, v, 0);
  return lines.join("\n");
}
