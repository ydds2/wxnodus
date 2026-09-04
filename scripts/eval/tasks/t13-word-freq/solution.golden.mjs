export default (text) => { const m = new Map(); for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) m.set(w, (m.get(w) ?? 0) + 1); return m; };
