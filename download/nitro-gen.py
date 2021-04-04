import random, string, requests, urllib.request, urllib, urllib.parse, colorama
from colorama import Fore as C
from colorama import Style as S

def gen():
	code = ''.join(random.choices(string.ascii_letters + string.digits, k=16))
	return(code)

url = "https://discordapp.com/api/v6/entitlements/gift-codes/" + gen + "?with_application=false&with_subscription_plan=true"
r = requests.get(url ,proxies=urllib.request.getproxies())
amount = int(input('Amount of nitro codes to try: '))

for _i in range(amount):
    if r.status_code == 200:
     print(style.GREEN + f"https://discord.gift/{gen} is valid")
    else:
     print(style.RED + f"https://discord.gift/{code} is invalid")
