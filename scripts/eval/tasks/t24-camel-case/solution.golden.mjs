export default (s) => s.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());
