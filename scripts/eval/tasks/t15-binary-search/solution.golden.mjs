export default (arr, t) => { let l=0, r=arr.length-1; while(l<=r){const m=(l+r)>>1; if(arr[m]===t)return m; if(arr[m]<t)l=m+1; else r=m-1;} return -1; };
