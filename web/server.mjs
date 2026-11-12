#!/usr/bin/env node
/**
 * 小蚁运动相机 · Web 控制台 —— 本地桥接服务（Node.js）
 *
 * 浏览器的页面脚本无法直接打开 TCP 连接访问相机的 7878 端口，
 * 所以由本服务在本机中转：
 *     页面 --HTTP/WebSocket--> server.mjs --TCP 7878--> 相机
 *
 * 用法：
 *     npm install       # 安装可选依赖 ws（未安装也能跑，只是退化为 HTTP 轮询）
 *     npm start         # 打开 http://127.0.0.1:8000
 *     node server.mjs --port 8080 --no-browser
 *
 * 环境要求：Node.js >= 18
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const HOST = arg('host', process.env.HOST || '127.0.0.1');
const PORT = Number(arg('port', process.env.PORT || 8000));
const DEFAULT_CAM = arg('cam', process.env.CAM || '192.168.42.1');
const OPEN_BROWSER = !argv.includes('--no-browser');

// 不放进配置页：前两个是危险动作，后两个由控制页专门处理
const IGNORE_PARAMS = new Set(['dev_reboot', 'restore_factory_settings', 'capture_mode', 'precise_self_running']);

const FILE_TYPES = {
  '/': '文件夹', '.ash': '脚本', '.bmp': '图片', '.ico': '图片', '.jpg': '图片',
  '.mka': '音频', '.mkv': '视频', '.mp3': '音频', '.mp4': '视频', '.mpg': '视频',
  '.png': '图片', '.txt': '文本', '.wav': '音频',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按大括号配平从字节流里切出完整 JSON 对象（跳过字符串内部） */
function splitJson(buf) {
  const out = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true;
      else if (c === 0x22) inStr = false;
      continue;
    }
    if (c === 0x22) inStr = true;
    else if (c === 0x7b) { if (depth === 0) start = i; depth++; }
    else if (c === 0x7d) {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) { out.push(buf.subarray(start, i + 1)); start = -1; }
      }
    }
  }
  return [out, start >= 0 ? buf.subarray(start) : Buffer.alloc(0)];
}

function humanSize(value) {
  const pres = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = Number(value) || 0, i = 0;
  while (v > 1024 && i < pres.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + pres[i];
}

function fileTypeOf(name) {
  const low = name.toLowerCase();
  for (const [ext, label] of Object.entries(FILE_TYPES)) {
    if (low.endsWith(ext)) return label;
  }
  return '文件';
}

/** 与相机 7878 端口的长连接：请求/响应派发 + 主动事件收集 */
class CamClient {
  constructor() {
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.addr = '';
    this.port = 7878;
    this.dataport = 8787;
    this.webport = 80;
    this.token = 0;
    this.connected = false;
    this.pending = new Map();
    this.chain = Promise.resolve();     // 命令串行化，同一时刻只下发一条
    this.events = [];
    this.cursor = 0;
    this.config = {};
    this.settable = {};
    this.battery = { type: '', param: '' };
    this.usage = { total: 0, free: 0 };
    this.pwd = '/var/www/DCIM';
    this.lastError = '';
    this.trace = [];
    this.monitorTimer = null;
  }

  log(dir, text) {
    this.trace.push({ dir, text, t: Date.now() });
    if (this.trace.length > 120) this.trace.shift();
  }

  send(obj) {
    if (!this.sock) throw new Error('尚未连接相机');
    const data = JSON.stringify(obj);
    this.log('tx', data);
    this.sock.write(data);
  }

  attach(sock) {
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('close', () => this.drop('与相机的连接已断开'));
    sock.on('error', (e) => this.drop('相机连接错误：' + e.message));
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const [objs, rest] = splitJson(this.buf);
    this.buf = rest;
    for (const raw of objs) {
      const text = raw.toString('utf8');
      this.log('rx', text);
      let obj;
      try { obj = JSON.parse(text); } catch { continue; }
      this.dispatch(obj);
    }
  }

  dispatch(obj) {
    const id = obj.msg_id;
    if (id === 7) { this.pushEvent(obj); return; }
    if (id === 257) this.token = obj.param;
    const waiter = this.pending.get(id);
    if (waiter) {
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.resolve(obj);
    }
  }

  pushEvent(obj) {
    this.cursor += 1;
    const ev = {
      seq: this.cursor,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      type: obj.type || '',
      param: obj.param === undefined ? '' : obj.param,
    };
    this.events.push(ev);
    if (this.events.length > 300) this.events.shift();
    broadcast();
  }

  waitFor(msgId, timeout) {
    return new Promise((resolve, reject) => {
      const prev = this.pending.get(msgId);
      if (prev) { clearTimeout(prev.timer); prev.reject(new Error('命令被新的同名请求替换')); }
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(new Error(`等待相机响应超时（msg_id=${msgId}）`));
      }, timeout);
      this.pending.set(msgId, { resolve, reject, timer });
    });
  }

  drop(reason) {
    if (this.monitorTimer) { clearTimeout(this.monitorTimer); this.monitorTimer = null; }
    this.connected = false;
    if (reason) this.lastError = reason;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason || '连接已断开'));
    }
    this.pending.clear();
    if (this.sock) { this.sock.destroy(); this.sock = null; }
    broadcast();
  }

  /** 下发命令并等待对应响应，令牌失效（rval=-4）时自动重新认证一次 */
  comm(payload, timeout = 10000) {
    const task = this.chain.then(() => this._comm(payload, timeout));
    this.chain = task.then(() => {}, () => {});
    return task;
  }

  /** 发送并等待响应；发送失败时清理挂起的等待者，避免未处理的 rejection */
  _request(payload, timeout) {
    const msgId = payload.msg_id;
    const wait = this.waitFor(msgId, timeout);
    try {
      this.send(payload);
    } catch (e) {
      const waiter = this.pending.get(msgId);
      if (waiter) { clearTimeout(waiter.timer); this.pending.delete(msgId); }
      throw e;
    }
    return wait;
  }

  async _comm(payload, timeout) {
    let res = await this._request(payload, timeout);
    if (res.rval === -4) {
      await this.auth();
      payload.token = this.token;
      res = await this._request(payload, timeout);
    }
    return res;
  }

  /** 认证（内部调用，不经过命令队列，避免自锁） */
  async auth(timeout = 6000) {
    const res = await this._comm({ msg_id: 257, token: 0 }, timeout);
    this.token = res.param;
    return this.token;
  }

  async connect(addr, port = 7878, dataport = 8787, webport = 80) {
    this.disconnect();
    const sock = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: addr, port: Number(port) });
      const timer = setTimeout(() => { s.destroy(); reject(new Error(`连接 ${addr}:${port} 超时`)); }, 6000);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (e) => { clearTimeout(timer); s.destroy(); reject(new Error(`无法连接 ${addr}:${port}（${e.message}）`)); });
    });
    sock.setNoDelay(true);
    this.sock = sock;
    this.addr = addr;
    this.port = Number(port);
    this.dataport = Number(dataport);
    this.webport = Number(webport);
    this.buf = Buffer.alloc(0);
    this.connected = true;
    this.lastError = '';
    this.attach(sock);
    await this.auth();
    this.config = await this.readConfig();
    this.startMonitor();
    return this.config;
  }

  disconnect() {
    if (this.monitorTimer) { clearTimeout(this.monitorTimer); this.monitorTimer = null; }
    this.connected = false;
    if (this.sock) { this.sock.destroy(); this.sock = null; }
    for (const [, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.reject(new Error('已断开')); }
    this.pending.clear();
    this.config = {};
    this.settable = {};
    this.battery = { type: '', param: '' };
    this.usage = { total: 0, free: 0 };
    this.token = 0;
  }

  /** 后台轮询相机状态，页面只读缓存 */
  startMonitor() {
    if (this.monitorTimer) return;
    let beat = 0, fails = 0;
    const tick = async () => {
      this.monitorTimer = null;
      if (!this.connected) return;
      try {
        this.config = await this.readConfig();
        if (beat % 4 === 0) {
          await this.updateBattery();
          await this.updateUsage();
        }
        fails = 0;
      } catch (e) {
        fails += 1;
        this.lastError = e.message;
        if (fails >= 3) { this.drop('相机连接中断：' + e.message); return; }
      }
      beat += 1;
      if (!this.connected) return;
      broadcast();
      this.monitorTimer = setTimeout(tick, 1500);
    };
    this.monitorTimer = setTimeout(tick, 150);
  }

  // ---------- 相机指令 ----------

  async readConfig() {
    const res = await this.comm({ msg_id: 3, token: this.token });
    const cfg = {};
    for (const item of res.param || []) {
      if (item && typeof item === 'object') Object.assign(cfg, item);
    }
    return cfg;
  }

  async getParam(name) {
    const res = await this.comm({ msg_id: 3, token: this.token, param: name });
    for (const item of res.param || []) {
      if (item && typeof item === 'object' && name in item) return item[name];
    }
    return '';
  }

  async readSettable() {
    const out = {};
    for (const name of Object.keys(this.config).sort()) {
      if (IGNORE_PARAMS.has(name)) continue;
      try {
        const value = await this.getParam(name);
        if (typeof value === 'string' && value.startsWith('settable:')) {
          const rest = value.slice('settable:'.length);
          out[name] = rest ? rest.split('#') : [];
        }
      } catch { /* 单个参数失败不影响整体 */ }
    }
    this.settable = out;
    return out;
  }

  async setParam(name, value) {
    if (name === 'camera_clock') value = formatNow();
    const res = await this.comm({ msg_id: 2, token: this.token, type: name, param: String(value) });
    try { this.config = await this.readConfig(); } catch { /* 忽略 */ }
    return res;
  }

  async updateBattery() {
    const res = await this.comm({ msg_id: 13, token: this.token });
    this.battery = { type: res.type || '', param: res.param === undefined ? '' : res.param };
    return this.battery;
  }

  async updateUsage() {
    const total = Number((await this.comm({ msg_id: 5, token: this.token, type: 'total' })).param || 0);
    const free = Number((await this.comm({ msg_id: 5, token: this.token, type: 'free' })).param || 0);
    this.usage = { total, free };
    return this.usage;
  }

  async photo() {
    const mode = this.config.capture_mode || '';
    const capturing = this.config.precise_cont_capturing === 'on';
    if (mode === 'precise quality cont.' && capturing) {
      return this.comm({ msg_id: 770, token: this.token });
    }
    return this.comm({ msg_id: 769, token: this.token });
  }

  recordStart() { return this.comm({ msg_id: 513, token: this.token }); }
  recordStop() { return this.comm({ msg_id: 514, token: this.token }); }

  async streamStart() {
    await this.comm({ msg_id: 259, token: this.token, param: 'none_force' });
    return `rtsp://${this.addr}:554/live`;
  }

  zoomSet(level) { return this.comm({ msg_id: 14, token: this.token, type: 'fast', param: String(level) }); }

  async zoomGet() {
    const res = await this.comm({ msg_id: 15, token: this.token, type: 'current' });
    const level = parseInt(res.param, 10);
    return Number.isFinite(level) ? level : 0;
  }

  // ---------- 文件 ----------

  async cd(pathName) {
    const res = await this.comm({ msg_id: 1283, token: this.token, param: pathName });
    this.pwd = res.pwd || pathName;
    return this.pwd;
  }

  async ls() {
    const res = await this.comm({ msg_id: 1282, token: this.token, param: ' -D -S' });
    const entries = [];
    for (const item of res.listing || []) {
      for (const [name, meta0] of Object.entries(item)) {
        const meta = String(meta0);
        const date = meta.includes(' bytes|') ? meta.split(' bytes|')[1] : '';
        if (name.endsWith('/')) {
          entries.push({ name, dir: true, size: 0, sizeText: '', date, type: '文件夹' });
        } else {
          const size = meta.includes(' bytes|') ? Math.round(Number(meta.split(' bytes|')[0]) || 0) : 0;
          entries.push({ name, dir: false, size, sizeText: humanSize(size), date, type: fileTypeOf(name) });
        }
      }
    }
    return entries;
  }

  async deleteFiles(names) {
    for (const name of names) {
      await this.comm({ msg_id: 1281, token: this.token, param: name });
    }
    return true;
  }

  /** 相机 80 端口上的文件地址（DCIM 之外走数据口，暂不支持） */
  httpUrl(pwd, name) {
    let rel = pwd || '/var/www/DCIM';
    if (rel.startsWith('/var/www/')) rel = rel.slice('/var/www/'.length);
    else if (rel.startsWith('/tmp/fuse_d/')) rel = rel.slice('/tmp/fuse_d/'.length);
    rel = rel.replace(/^\/+|\/+$/g, '');
    const head = rel ? encodeURI(rel) + '/' : '';
    return `http://${this.addr}:${this.webport}/${head}${encodeURIComponent(name)}`;
  }

  async upload(name, data) {
    const md5 = crypto.createHash('md5').update(data).digest('hex');
    const ds = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.addr, port: this.dataport });
      s.once('connect', () => resolve(s));
      s.once('error', (e) => { s.destroy(); reject(new Error(`打不开数据端口 ${this.dataport}（${e.message}）`)); });
    });
    try {
      const fromSeq = this.cursor;
      const res = await this.comm({
        msg_id: 1286, token: this.token, md5sum: md5, param: name, offset: 0, size: data.length,
      }, 15000);
      if (Number(res.rval) !== 0) throw new Error(`相机拒绝写入文件（rval=${res.rval}）`);
      for (let off = 0; off < data.length; off += 65536) {
        if (!ds.write(data.subarray(off, off + 65536))) await once(ds, 'drain');
      }
      await this.waitEvent('put_file_complete', fromSeq, 30000);
    } finally {
      ds.destroy();
    }
    return true;
  }

  async waitEvent(type, fromSeq, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const hit = this.events.find((e) => e.seq > fromSeq && e.type === type);
      if (hit) return hit;
      await sleep(100);
    }
    throw new Error('等待写入完成超时');
  }
}

function formatNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const cam = new CamClient();

// ------------------------------------------------------------------ 接口动作

async function doAction(payload) {
  const action = payload.action || '';

  if (action === 'connect') {
    const addr = String(payload.addr || DEFAULT_CAM).trim();
    const config = await cam.connect(addr, payload.port || 7878, payload.dataport || 8787, payload.webport || 80);
    broadcast();
    return { config };
  }

  if (action === 'disconnect') {
    cam.disconnect();
    broadcast();
    return {};
  }

  if (!cam.connected) throw new Error('尚未连接相机');

  switch (action) {
    case 'refresh':
      cam.config = await cam.readConfig();
      return { config: cam.config };
    case 'config':
      return { config: await cam.readConfig() };
    case 'settable':
      return { settable: await cam.readSettable(), config: await cam.readConfig() };
    case 'set':
      await cam.setParam(payload.name, payload.value === undefined ? '' : payload.value);
      return { config: cam.config };
    case 'clock':
      await cam.setParam('camera_clock', '');
      return { config: cam.config };
    case 'photo':
      await cam.photo();
      try { cam.config = await cam.readConfig(); } catch { /* 忽略 */ }
      return {};
    case 'record_start':
      await cam.recordStart();
      cam.config = await cam.readConfig();
      return { config: cam.config };
    case 'record_stop':
      await cam.recordStop();
      cam.config = await cam.readConfig();
      return { config: cam.config };
    case 'stream':
      return { rtsp: await cam.streamStart() };
    case 'zoom':
      await cam.zoomSet(payload.level || 0);
      return {};
    case 'zoom_get':
      return { level: await cam.zoomGet() };
    case 'battery':
      return { battery: await cam.updateBattery() };
    case 'usage':
      cam.usage = await cam.updateUsage();
      return { usage: cam.usage };
    case 'info':
      return {
        info: {
          sw_version: cam.config.sw_version || '',
          hw_version: cam.config.hw_version || '',
          serial_number: cam.config.serial_number || '',
        },
      };
    case 'variables':
      return { variables: cam.config };
    case 'ls':
      await cam.cd(payload.path || '/var/www/DCIM');
      return { pwd: cam.pwd, entries: await cam.ls() };
    case 'cd':
      await cam.cd(payload.name || '/var/www/DCIM');
      return { pwd: cam.pwd, entries: await cam.ls() };
    case 'delete':
      await cam.deleteFiles(payload.names || []);
      await cam.updateUsage();
      return { pwd: cam.pwd, entries: await cam.ls() };
    case 'format':
      await cam.comm({ msg_id: 4, token: cam.token }, 20000);
      await cam.updateUsage();
      return {};
    case 'reboot':
      cam.send({ msg_id: 2, token: cam.token, type: 'dev_reboot', param: 'on' });
      await sleep(300);
      cam.connected = false;
      return {};
    case 'factory':
      cam.send({ msg_id: 2, token: cam.token, type: 'restore_factory_settings', param: 'on' });
      await sleep(300);
      cam.connected = false;
      return {};
    case 'telnet': {
      const old = await cam.cd('/tmp/fuse_d');
      await cam.comm({
        msg_id: 1286, token: cam.token, param: 'enable_info_display.script',
        offset: 0, size: 0, md5sum: 'd41d8cd98f00b204e9800998ecf8427e',
      }, 15000);
      await cam.cd(old);
      return {};
    }
    default:
      throw new Error('未知操作：' + action);
  }
}

function statusPayload(after = null) {
  const from = after === null ? cam.cursor : after;
  return {
    ok: true,
    connected: cam.connected,
    addr: cam.addr,
    port: cam.port,
    dataport: cam.dataport,
    webport: cam.webport,
    config: cam.config,
    battery: cam.battery,
    usage: cam.usage,
    pwd: cam.pwd,
    cursor: cam.cursor,
    events: cam.events.filter((e) => e.seq > from),
    error: cam.lastError,
    log: cam.trace.slice(-60),
  };
}

// ------------------------------------------------------------------ HTTP 工具

function sendJson(res, data, code = 200) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, rel) {
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 页面不存在');
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const stat = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyDownload(res, pwd, name) {
  if (!name) throw new Error('缺少文件名');
  const url = cam.httpUrl(pwd, name);
  const upstream = await new Promise((resolve, reject) => {
    http.get(url, resolve).on('error', reject);
  });
  if (upstream.statusCode !== 200) {
    upstream.resume();
    throw new Error(`相机返回 HTTP ${upstream.statusCode}（${url}）`);
  }
  const headers = {
    'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];
  res.writeHead(200, headers);
  upstream.pipe(res);
}

// ------------------------------------------------------------------ 服务入口

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/' || url.pathname === '/index.html') return sendFile(res, 'index.html');

    if (url.pathname === '/api/status') {
      const after = Number(url.searchParams.get('after'));
      return sendJson(res, statusPayload(Number.isFinite(after) ? after : null));
    }
    if (url.pathname === '/api/action') {
      const raw = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* 空请求体 */ }
      const result = await doAction(payload);
      return sendJson(res, { ok: true, ...result });
    }
    if (url.pathname === '/api/download') {
      return await proxyDownload(res, url.searchParams.get('dir') || cam.pwd, url.searchParams.get('name') || '');
    }
    if (url.pathname === '/api/upload') {
      if (!cam.connected) throw new Error('尚未连接相机');
      const dir = url.searchParams.get('dir') || cam.pwd;
      const name = url.searchParams.get('name') || '';
      if (!name) throw new Error('缺少文件名');
      const data = await readBody(req, 1024 * 1024 * 1024);
      if (!data.length) throw new Error('文件内容为空');
      await cam.cd(dir);
      await cam.upload(name, data);
      return sendJson(res, { ok: true, entries: await cam.ls() });
    }
    return sendFile(res, decodeURIComponent(url.pathname.replace(/^\//, '')));
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    return sendJson(res, { ok: false, error: e.message || String(e) }, 400);
  }
});

// WebSocket 实时推送（可选依赖，未安装时页面自动退化为 HTTP 轮询）
let wss = null;
try {
  const { WebSocketServer } = await import('ws');
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (client) => {
    client.send(JSON.stringify({ type: 'status', data: statusPayload() }));
  });
} catch {
  console.log('提示：未安装 ws，实时推送不可用，页面将使用 HTTP 轮询（npm install 可启用）');
}

function broadcast() {
  if (!wss || !wss.clients.size) return;
  const msg = JSON.stringify({ type: 'status', data: statusPayload() });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const target = `http://${shown}:${PORT}/`;
  console.log('小蚁相机 Web 控制台已启动：' + target);
  console.log(`相机默认地址：${DEFAULT_CAM}   （Ctrl+C 结束）`);
  if (OPEN_BROWSER) {
    const cmd = process.platform === 'win32' ? `start "" "${target}"`
      : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
    setTimeout(() => exec(cmd, () => {}), 600);
  }
});

const shutdown = () => {
  console.log('\n正在关闭…');
  cam.disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
