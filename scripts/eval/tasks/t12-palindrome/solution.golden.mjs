export default (s) => { const c = s.toLowerCase().replace(/[^a-z\u4e00-\u9fff]/g, ''); return c === [...c].reverse().join(''); };
