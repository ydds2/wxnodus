export default (a) => { const out=[]; const walk=(x)=>{if(Array.isArray(x))x.forEach(walk);else out.push(x)}; walk(a); return out; };
