export default (a, f) => { const r = {}; for (const x of a) { const k = f(x); (r[k] ??= []).push(x); } return r; };
