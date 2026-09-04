export default (t, v) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] !== undefined ? String(v[k]) : '{{' + k + '}}');
