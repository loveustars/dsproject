# Backend 目录说明

后端代码统一放在 `Backend/` 下：

- `src/index.js`：服务入口
- `POST /api/route`：给前端右侧路线面板提供数据
- `GET /health`：健康检查

## 启动

```bash
npm install
npm run dev
```

启动后把前端“路线规划 API 地址”配置为：

`http://localhost:3000/api/route`
