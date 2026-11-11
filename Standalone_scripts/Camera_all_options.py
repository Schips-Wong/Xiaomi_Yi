#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# 作者 Andy（中文版）

# 功能：列出相机全部配置项，并逐项查询每个参数的当前值及可选值

import os, re, sys, time, socket
from settings import camaddr
from settings import camport

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.connect((camaddr, camport))

# 向相机认证以获取令牌
srv.send('{"msg_id":257,"token":0}'.encode("utf-8"))

data = srv.recv(512).decode("utf-8", "ignore")
if "rval" in data:
	token = re.findall('"param": (.+) }',data)[0]
else:
	data = srv.recv(512).decode("utf-8", "ignore")
	if "rval" in data:
		token = re.findall('"param": (.+) }',data)[0]

# 请求完整配置列表
tosend = '{"msg_id":3,"token":%s}' %token
srv.send(tosend.encode("utf-8"))

while 1:
	conf = srv.recv(4096).decode("utf-8", "ignore")
	if "param" in conf:
		break

conf = conf[37:]

myconf = conf.split(",")

# 逐个参数查询详细设置并打印
for mytag in myconf:
	if len(mytag) > 5:
		paramname = re.findall ('{ "(.+)": "', mytag)[0]
		tosend = '{"msg_id":3,"token":%s,"param":"%s"}' %(token, paramname)
		srv.send(tosend.encode("utf-8"))
		print(srv.recv(8192).decode("utf-8", "ignore"))


print("_____________________________________________")
print()
print("按 CTRL+C 关闭")

while 1:
	time.sleep(1)
