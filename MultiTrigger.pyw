#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# Res andy (Python 3 + 中文界面版)

AppVersion = "0.1.1"



import base64, functools, hashlib, json, os, platform, re, select, socket, subprocess, sys, tempfile, threading, time, urllib.request, webbrowser, zlib
from tkinter import *
from tkinter import messagebox
from operator import itemgetter

class App:

	def __init__(self, master):
		self.connected = {}
		self.camconfig = {}
		self.camconfig["capture_mode"]="precise quality"
		self.ActualAction = ""
		self.defaultbg = master.cget('bg')
		self.camsettableconfig = {}
		self.ZoomLevelValue = ""
		self.ZoomLevelOldValue = ""
		self.thread_zoom = ""
		self.CamAddresses = {}
		self.CamSockets = {}
		self.CamTokens = {}
		self.JsonData = {}
		self.Jsondata = {}
		self.Jsoncounter = {}
		self.Jsonflip = {}
		self.initcounter = {}
		self.AllConnected = True

		self.DonateUrl = "http://sw.deltaflyer.cz/donate.html"
		self.GitUrl = "https://github.com/deltaflyer4747/Xiaomi_Yi"
		self.UpdateUrl = "https://raw.githubusercontent.com/deltaflyer4747/Xiaomi_Yi/master/Multi_version.txt"
		self.master = master
		self.master.geometry("445x250+300+75")
		self.master.wm_title("小米小蚁 多机联拍 by Andy_S | 版本 %s" %AppVersion)
		self.Settings()


		# 创建菜单
		self.menu = Menu(self.master)
		root.config(menu=self.menu)

		self.Cameramenu = Menu(self.menu, tearoff=0)
		self.menu.add_cascade(label="相机", menu=self.Cameramenu, underline=0)
		self.Cameramenu.add_separator()
		self.Cameramenu.add_command(label="退出", command=self.quit, underline=1)

		self.helpmenu = Menu(self.menu, tearoff=0)
		self.menu.add_cascade(label="帮助", menu=self.helpmenu, underline=0)
		self.helpmenu.add_command(label="捐赠", command=lambda aurl=self.DonateUrl:webbrowser.open_new(aurl), underline=0)
		self.helpmenu.add_command(label="关于...", command=self.AboutProg, underline=0)
		self.UpdateCheck()
		self.ConnWindow()

	def noaction(self, *args):
		return

	def Settings(self, add="", rem=""):
		if add == "" and rem == "": #没有要添加或删除的项 = 初始调用
			try: #打开设置文件（如果存在）并读取设置
				filek = open("Multisettings.cfg","r", encoding="utf-8")
				filet = filek.readlines()
				filek.close()
				a=1
				for line in filet:
					if not line.startswith("#"):
						addr = line.split(" ")
						self.CamAddresses[a] = [addr[0], int(addr[1])]
						a+=1

			except Exception as e: #还没有设置文件或文件结构不匹配 - 创建示例配置并提示
				print(e)
				filek = open("Multisettings.cfg_example","w", encoding="utf-8")
				ConfigFile = '192.168.0.10 7878\n#192.168.0.11 7878'
				filek.write(ConfigFile)
				filek.close()
				messagebox.showerror("配置文件损坏", "配置文件损坏。\n\n 请使用如下格式\n\n相机IP地址 端口\n\n例如\n192.168.0.10 7878")

	def ConnWindow(self):
		self.camconn = Frame(self.master) #创建带按钮的连接窗口
		b = Button(self.camconn, text="连接多机联拍", width=20, command=self.CamConnect)
		b.focus_set()
		b.grid(row=1, column=1, padx=10, pady=2)
		self.camconn.pack(side=TOP, fill=X)

	def UpdateCheck(self):
		try:
			newversion = urllib.request.urlopen(self.UpdateUrl, timeout=2).read().decode("utf-8").strip()
		except Exception:
			newversion = "0"
		if newversion > AppVersion:
			if messagebox.askyesno("发现新版本", "发现新版本（%s）\n当前版本为 %s\n\n是否打开下载页面？" %(newversion, AppVersion)):
				webbrowser.open_new(self.GitUrl)



	def AboutProg(self):
		messagebox.showinfo("关于", "多机联拍 | 版本 %s\n作者 Andy_S，2015\n\nandys@deltaflyer.cz" %AppVersion)

	def CamConnect(self):
		try:
			socket.setdefaulttimeout(5)
			for CamID in self.CamAddresses.keys():
				camaddr, camport = self.CamAddresses[CamID]
				self.CamSockets[CamID] = socket.socket(socket.AF_INET, socket.SOCK_STREAM) #创建套接字
				self.CamSockets[CamID].setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
				self.CamSockets[CamID].setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
				self.CamSockets[CamID].connect((camaddr, camport)) #打开套接字
			self.thread_read = threading.Thread(target=self.JsonReader)
			self.thread_read.daemon = True
			self.thread_read.setName('JsonReader')
			self.thread_read.start()
			waiter = 0
			while 1:
				ThisConnected = True
				if len(self.CamTokens) == len(self.CamSockets):
					for connect in self.connected.values():
						if connect != True:
							ThisConnected = False
				else:
					ThisConnected = False
				if ThisConnected:
					for token in self.CamTokens:
						try:
							token = int(token)
						except:
							break
					self.camconn.destroy() #隐藏连接选择界面
					self.MainWindow()
					break
				else:
					if waiter <=15:
						time.sleep(1)
						waiter += 1
					else:
						raise Exception('Connection', 'failed') #抛出异常


		except Exception as e:
			self.AllConnected = False
			messagebox.showerror("连接", "无法连接到指定的地址")
			for CamID in self.CamSockets.keys():
				try:
					self.CamSockets[CamID].close()
				except Exception:
					pass


	def JsonLoop(self, CamID):
		try:
			ready = select.select([self.CamSockets[CamID]], [], [])
			if ready[0]:
				byte = self.CamSockets[CamID].recv(1)
				if byte == b"{":
					self.Jsoncounter[CamID] += 1
					self.Jsonflip[CamID] = 1
				elif byte == b"}":
					self.Jsoncounter[CamID] -= 1
				self.Jsondata[CamID] += byte

				if self.Jsonflip[CamID] == 1 and self.Jsoncounter[CamID] == 0:
					try:
						data_dec = json.loads(self.Jsondata[CamID])
						self.Jsondata[CamID] = ""
						self.Jsonflip[CamID] = 0
						if "msg_id" in data_dec.keys():
							if data_dec["msg_id"] == 257:
								self.CamTokens[CamID] = data_dec["param"]
							self.JsonData[CamID][data_dec["msg_id"]] = data_dec
						else:
							raise Exception('Unknown data from camera ID ', CamID)
					except Exception as e:
						print(data_dec)
		except Exception:
			self.connected[CamID] = False



	def JsonReader(self):
		for CamID in self.CamSockets.keys():
			self.Jsondata[CamID] = ""
			self.JsonData[CamID] = {}
			self.Jsoncounter[CamID] = 0
			self.Jsonflip[CamID] = 0
			self.initcounter[CamID] = 0
			self.CamSockets[CamID].send('{"msg_id":257,"token":0}'.encode("utf-8")) #向相机认证
			while self.initcounter[CamID] < 300:
				self.JsonLoop(CamID)
				self.initcounter[CamID] += 1
				if len(self.JsonData[CamID]) > 0:
					self.connected[CamID] = True
					break

		while self.AllConnected:
			for CamID in self.CamSockets.keys():
				self.CamSockets[CamID].setblocking(0)
				self.connected[CamID] = True
				self.JsonLoop(CamID)

	def Comm(self, tosend):
		Jtosend = json.loads(tosend)
		msgid = Jtosend["msg_id"]
		for CamID in self.CamSockets.keys():
			Jtosend["token"] = self.CamTokens[CamID]
			tosend = json.dumps(Jtosend)
			self.JsonData[CamID][msgid] = ""
			self.CamSockets[CamID].send(tosend.encode("utf-8"))

		for CamID in self.CamSockets.keys():
			while self.JsonData[CamID][msgid]=="":continue
			if self.JsonData[CamID][msgid]["rval"] == -4: #令牌错误，重新获取并重发 - 应对相机坚持要求令牌的“变通办法”
				messagebox.showerror("有相机未触发", "%s 号相机未正常触发\n\n请检查该相机\n后重新拍摄。" %CamID)
				self.CamTokens[CamID] = ""
				self.CamSockets[CamID].send('{"msg_id":257,"token":0}'.encode("utf-8"))
				while self.CamTokens[CamID]=="":continue
				Jtosend["token"] = self.CamTokens[CamID]
				tosend = json.dumps(Jtosend)
				self.JsonData[CamID][msgid] = ""
				self.CamSockets[CamID].send(tosend.encode("utf-8"))
				while self.JsonData[CamID][msgid]=="":continue
		return self.JsonData[1][msgid]


	def MainWindow(self):
		self.mainwindow = Frame(self.master, width=550, height=400)
		self.mainwindow.pack(side=TOP, fill=X)
		self.MenuControl()


	def MenuControl(self, *args):
		try:
			self.content.destroy()
		except Exception:
			pass
		self.master.geometry("475x250+300+75")
		self.content = Frame(self.mainwindow)
		self.controlbuttons = Frame(self.content)
		if self.camconfig["capture_mode"] == "precise quality":
			self.bphoto = Button(self.controlbuttons, text="拍一张\n照片", width=13, command=self.ActionPhoto, bg="#ccccff")
		elif self.camconfig["capture_mode"] == "precise quality cont.":
			if self.camconfig["precise_cont_capturing"] == "off":
				self.bphoto = Button(self.controlbuttons, text="开始\n延时摄影", width=13, command=self.ActionPhoto, bg="#66ff66")
			else:
				self.bphoto = Button(self.controlbuttons, text="停止\n延时摄影", width=13, command=self.ActionPhoto, bg="#ff6666")
		elif self.camconfig["capture_mode"] == "burst quality":
			self.bphoto = Button(self.controlbuttons, text="连拍\n照片", width=13, command=self.ActionPhoto, bg="#ffccff")
		elif self.camconfig["capture_mode"] == "precise self quality":
			self.bphoto = Button(self.controlbuttons, text="定时\n拍照", width=13, command=self.ActionPhoto, bg="#ccffff")
		self.bphoto.pack(side=LEFT, padx=12, pady=5)


		self.brecord = Button(self.controlbuttons, text="开始\n录像", width=7, command=self.ActionRecordStart, bg="#66ff66")
		self.brecord.pack(side=LEFT, padx=10, ipadx=5, pady=5)
		if self.camconfig["capture_mode"] == "precise quality cont.":
			if self.camconfig["precise_cont_capturing"] == "on":
				self.brecord.config(state=DISABLED)
				self.brecord.update_idletasks()

		if self.ZoomLevelValue == "":
			tosend = '{"msg_id":15,"type":"current"}'
			resp = self.Comm(tosend)
			ThisZoomLevelValue = int(resp["param"])
		else:
			ThisZoomLevelValue = self.ZoomLevelValue

		if self.thread_zoom == "":
			self.thread_zoom = threading.Thread(target=self.ActionZoomChangeThread)
			self.thread_zoom.start()



		self.ZoomLevelFrame = Frame(self.controlbuttons, width=50)
		self.ZoomLevel = Scale(self.ZoomLevelFrame, from_=0, to=100, orient=HORIZONTAL, width=10, length=150, command=self.ActionZoomChange)
		self.ZoomLevel.set(ThisZoomLevelValue)
		self.ZoomLevel.pack(side=TOP)
		Label(self.ZoomLevelFrame, width=10, text="变焦级别", anchor=W).pack(side=TOP)
		self.ZoomLevelFrame.pack(side=TOP, fill=X, padx=5)

		self.controlbuttons.pack(side=TOP, fill=X)


		self.FramePhotoButtonMod = Frame(self.content)
		self.Photo_options = {"precise quality":"单拍","precise quality cont.":"延时","burst quality":"连拍","precise self quality":"定时"}
		self.Photo_thisvalue = StringVar(self.FramePhotoButtonMod)
		self.Photo_thisvalue.set(self.Photo_options[self.camconfig["capture_mode"]]) #实际值
		self.Photo_thisvalue.trace("w", self.MenuPhoto_changed)
		self.Photo_valuebox = OptionMenu(self.FramePhotoButtonMod, self.Photo_thisvalue, *list(self.Photo_options.values()))
		self.Photo_valuebox.config(width=10)
		self.Photo_valuebox.pack(side=LEFT, padx=10)
		self.FramePhotoButtonMod.pack(side=TOP, fill=X)


		self.content.pack(side=TOP, fill=X)

	def MenuPhoto_changed(self, *args):
		myoption = list(self.Photo_options.keys())[list(self.Photo_options.values()).index(self.Photo_thisvalue.get())]
		tosend = '{"msg_id":2, "type":"capture_mode", "param":"%s"}' %(myoption)
		self.Comm(tosend)
		self.camconfig["capture_mode"] = myoption
		self.MenuControl()


	def ActionZoomChangeThread(self):
		while self.AllConnected:
			if self.ZoomLevelOldValue != self.ZoomLevelValue:
				tosend = '{"msg_id":14,"type":"fast","param":"%s"}' %(self.ZoomLevelValue)
				self.Comm(tosend)
				self.ZoomLevelOldValue = self.ZoomLevelValue
			time.sleep(1)

	def ActionZoomChange(self, *args):
		self.ZoomLevelValue = self.ZoomLevel.get()

	def ActionPhoto(self):
		myid = 769
		tosend = '{"msg_id":769}'
		if self.camconfig["capture_mode"] == "precise quality cont.":
			if self.camconfig["precise_cont_capturing"] == "on":
				tosend = '{"msg_id":770}'
				myid = 770
			self.Comm(tosend)
		else:
			self.Comm(tosend)


	def ActionRecordStart(self):
		tosend = '{"msg_id":513}'
		self.Comm(tosend)
		self.brecord.config(text="停止\n录像", command=self.ActionRecordStop, bg="#ff6666")
		self.brecord.update_idletasks()
		self.bphoto.config(state=DISABLED)
		self.bphoto.update_idletasks()

	def ActionRecordStop(self):
		tosend = '{"msg_id":514}'
		self.Comm(tosend)
		self.brecord.config(text="开始\n录像", command=self.ActionRecordStart, bg="#66ff66")
		self.brecord.update_idletasks()
		self.bphoto.config(state="normal")
		self.bphoto.update_idletasks()


	def quit(self):
		self.AllConnected = False
		time.sleep(1)
		for CamID in self.CamSockets.keys():
			try:
				self.CamSockets[CamID].shutdown(socket.SHUT_RDWR)
				self.CamSockets[CamID].close()
			except: pass

		sys.exit()




root = Tk()
mysys = os.name
if mysys == "nt":
	ICON = zlib.decompress(base64.b64decode('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'))
	_, ICON_PATH = tempfile.mkstemp()
	with open(ICON_PATH, 'wb') as icon_file:
		icon_file.write(ICON)
	root.iconbitmap(default=ICON_PATH)


app = App(root)
root.protocol("WM_DELETE_WINDOW", app.quit)
root.mainloop()
