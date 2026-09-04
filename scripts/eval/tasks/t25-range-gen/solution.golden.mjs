export default (s, e, st=1) => { const r=[]; for(let i=s;(st>0?i<e:i>e);i+=st)r.push(i); return r; };
