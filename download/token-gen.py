import random, string, requests, urllib.request, urllib, urllib.parse, colorama, os
from colorama import Fore as C
from colorama import Style as S
from random import randint

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
    

sample_string = str(randint(000000000000000000, 999999999999999999))
sample_string_bytes = sample_string.encode("ascii")
base64_bytes = base64.b64encode(sample_string_bytes)
base64_string = base64_bytes.decode("ascii")
tk = base64_string+"."+random.choice(string.ascii_letters).upper()+''.join(random.choice(string.ascii_letters + string.digits)
                                                                                      for _ in range(5))+"."+''.join(random.choice(string.ascii_letters + string.digits) for _ in range(27))
header = {
    "Content-Type": "application/json",
    "authorization": tk
}
r = requests.get("https://discordapp.com/api/v6/users/@me/library", headers=header, proxies=urllib.request.getproxies())
amount = int(input('Amount of tokens to try: '))

for _i in range(amount):
    if r.status_code == 200:
     print(style.GREEN +f"{tk} is valid")
    else:
     print(style.RED +f"{tk} is invalid")
