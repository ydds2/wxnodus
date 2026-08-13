const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('fixture', {
  reportInvoke: () => { /* renderer 侧状态翻转；状态文本由 DOM 更新 */ },
});
