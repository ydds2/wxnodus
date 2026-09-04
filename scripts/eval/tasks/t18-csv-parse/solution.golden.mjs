export default (t) => t.split('\n').map(l => l.split(',').map(c => c.replace(/^"|"$/g, '')));
