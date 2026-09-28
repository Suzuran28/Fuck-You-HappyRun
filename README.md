# Fuck-You-HappyRun

![Github](https://img.shields.io/badge/github-Suzuran28-blue?logo=github&link=https%3A%2F%2Fgithub.com%2FSuzuran28
) ![Require](https://img.shields.io/badge/Nodejs->=18-blue)  ![License](https://img.shields.io/badge/license-MIT-yellow)

> 针对某山西大学乐跑，实现了模拟轨迹/寻路算法过打卡点/陀螺仪数据

## 目录结构

```
main/
├── auto-run.mjs               # 主入口：运行一次完整乐跑流程
├── config.json                # 配置文件（登录态 / 跑步参数）
├── lib/
│   ├── client.mjs             # HTTP 客户端：AES 加解密、签名、白名单校验
│   ├── signer.mjs             # 加密工具：AES-128-CBC、MD5 签名、POST body 组装
│   ├── track.mjs              # 轨迹生成：伪 GPS 点、步数、陀螺仪数据
│   ├── route.mjs              # 路径规划：环形跑道图、A* 寻路、路网规划
│   ├── record.mjs             # 记录组装：白名单过滤、log_data 构造、start_time 容差
│   ├── oss.mjs                # OSS 直传：STS 凭证获取、PostObject 上传、只读下载
│   └── config.mjs             # 参数管理：默认配置与 config.json 合并
└── README.md                  # 本文件
```

## 不提供精确的使用方法，请自行摸索直到本人不需要乐跑()

- 使用方法：
- 1. 安装依赖，Nodejs，Python
- 2. 获取登录token
- 3. bash运行auto-rum.mjs

## 成功记录
![img](assets/success_img.png)

## 核心流程

```
┌──────────────────────────────────────────────────────────────┐
│  0. 登录态校验 (UserInfo)                                     │
├──────────────────────────────────────────────────────────────┤
│  1. beforeRunV260 → game_id / run_zone_latlng 质心 / 规则      │
├──────────────────────────────────────────────────────────────┤
│  2. getTimestampV278 (第一次) → 服务端时间戳                    │
├──────────────────────────────────────────────────────────────┤
│  3. [正式跑] 从 run_line_info.point_list 按距离选择 3 个打卡点  │
│     算法复刻 setClocks：type 分类 + calcDis 分层 + shuffle       │
├──────────────────────────────────────────────────────────────┤
│  4. 真实等待 usedTimeS 秒（is_check_time 要求墙钟耗时达标）     │
├──────────────────────────────────────────────────────────────┤
│  5. getTimestampV278 (第二次) → 校准 end_time 时间窗口         │
├──────────────────────────────────────────────────────────────┤
│  6. 路网规划路径 + 本地构造 record（轨迹 / 步数 / 陀螺仪）     │
├──────────────────────────────────────────────────────────────┤
│  7. OSS 上传轨迹文件（distance>0.2km 时，AES 加密）            │
├──────────────────────────────────────────────────────────────┤
│  8. stopRunV278 / stopFreeRunV220 上传记录（16 字段白名单）    │
├──────────────────────────────────────────────────────────────┤
│  9. 补传陀螺仪数据（明文 JSON，gyroscope_file 含完整 OSS key）  │
└──────────────────────────────────────────────────────────────┘
```

Copyright (c) 2026 Suzuran