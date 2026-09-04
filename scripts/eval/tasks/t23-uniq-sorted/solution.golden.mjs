export default (a) => { const s=[...a].sort((x,y)=>x-y); const r=[]; for(const x of s){if(r.length===0||r[r.length-1]!==x)r.push(x)} return r; };
