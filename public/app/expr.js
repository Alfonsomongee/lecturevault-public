// Safe evaluator for the function plots in the notes. The model writes things like "sin(x)/x" or "2*x^2 - 3";
// this parses them with a small recursive-descent parser, never with eval/Function, so nothing it writes can run.

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10,
  log2: Math.log2, sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow,
};
const CONSTS = { pi: Math.PI, e: Math.E };
const MAX_LENGTH = 200;
const MAX_DEPTH = 40;

/** Names an expression may use (also what the server checks against) */
export const EXPR_FUNCTIONS = Object.keys(FUNCS);
export const EXPR_CONSTANTS = Object.keys(CONSTS);

function normalize(src) {
  return String(src)
    .replace(/[−–—]/g, '-')
    .replace(/[·×⋅]/g, '*')
    .replace(/π/g, 'pi')
    .replace(/²/g, '^2').replace(/³/g, '^3')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([a-z_][a-z0-9_]*)|(.))/gy;
  let m;
  while ((m = re.exec(src)) && m[0] !== '') {
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2] });
    else if (m[3] !== undefined && m[3].trim()) tokens.push({ t: 'op', v: m[3] });
  }
  return tokens;
}

/**
 * Compile an expression in x into a function. Throws an Error with a readable message when it is not valid.
 * Implicit multiplication ("2x", "3(x+1)", "x sin(x)") is accepted; "^" is right-associative.
 */
export function compile(source) {
  const src = normalize(source);
  if (!src) throw new Error('Expresión vacía');
  if (src.length > MAX_LENGTH) throw new Error('Expresión demasiado larga');
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const expectOp = (v) => { if (!isOp(v)) throw new Error(`Se esperaba «${v}»`); pos++; };
  const startsPrimary = () => {
    const t = peek();
    return !!t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.v === '('));
  };
  const enter = () => { if (++depth > MAX_DEPTH) throw new Error('Expresión demasiado anidada'); };
  const leave = () => { depth--; };

  function parseExpr() {
    enter();
    let left = parseTerm();
    while (isOp('+') || isOp('-')) {
      const plus = peek().v === '+';
      pos++;
      const l = left, r = parseTerm();
      left = plus ? (x) => l(x) + r(x) : (x) => l(x) - r(x);
    }
    leave();
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const mul = peek().v === '*';
        pos++;
        const l = left, r = parseUnary();
        left = mul ? (x) => l(x) * r(x) : (x) => l(x) / r(x);
      } else if (startsPrimary()) {
        const l = left, r = parseUnary(); // implicit multiplication
        left = (x) => l(x) * r(x);
      } else return left;
    }
  }

  function parseUnary() {
    if (isOp('-')) { pos++; enter(); const f = parseUnary(); leave(); return (x) => -f(x); }
    if (isOp('+')) { pos++; return parseUnary(); }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (isOp('^')) {
      pos++;
      enter();
      const exp = parseUnary();
      leave();
      return (x) => Math.pow(base(x), exp(x));
    }
    return base;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('La expresión termina de forma inesperada');
    pos++;
    if (t.t === 'num') { const v = t.v; return () => v; }
    if (t.t === 'op' && t.v === '(') { const f = parseExpr(); expectOp(')'); return f; }
    if (t.t === 'id') {
      if (t.v === 'x') return (x) => x;
      if (Object.prototype.hasOwnProperty.call(CONSTS, t.v)) { const v = CONSTS[t.v]; return () => v; }
      if (Object.prototype.hasOwnProperty.call(FUNCS, t.v)) {
        const fn = FUNCS[t.v];
        expectOp('(');
        const args = [parseExpr()];
        while (isOp(',')) { pos++; args.push(parseExpr()); }
        expectOp(')');
        return (x) => fn(...args.map((a) => a(x)));
      }
      throw new Error(`«${t.v}» no se reconoce (solo x, pi, e y funciones básicas)`);
    }
    throw new Error(`Símbolo inesperado «${t.v}»`);
  }

  const fn = parseExpr();
  if (pos < tokens.length) throw new Error(`Sobra «${tokens[pos].v}»`);
  return fn;
}

/** Sample f over [xMin, xMax]; breaks the curve (null) where the value is not finite or jumps (asymptotes). */
export function sample(fn, xMin, xMax, count = 400) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const x = xMin + ((xMax - xMin) * i) / count;
    let y;
    try { y = fn(x); } catch { y = NaN; }
    pts.push(Number.isFinite(y) ? { x, y } : null);
  }
  return pts;
}
