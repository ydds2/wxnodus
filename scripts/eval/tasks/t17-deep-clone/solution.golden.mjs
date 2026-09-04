export default function clone(o){if(o===null||typeof o!=='object')return o;if(Array.isArray(o))return o.map(clone);const r={};for(const k of Object.keys(o))r[k]=clone(o[k]);return r}
