# OWNER DETAILS CHECKLIST — sirf woh details jo AAP ko bharni hain

Ye woh akhri list hai jo sirf aap de sakte hain. Har method ke liye teen
sawal: **(1) kahan jana hai** (kis site/app me), **(2) wahan kis naam se
milega**, **(3) copy karke hamare Admin Panel ke kis khane me dalna hai**.
Dono pages sath sath kholein — naam se naam milayein, puzzle nahi hoga.

Admin Panel me method ki jagah: **Payment Methods → method ka naam →
Credentials**. Har khane ke neeche wahan bhi likha hota hai ke ye Manual
ke liye chahiye ya sirf Auto/API ke liye.

⚠️ **Secret wali cheezein (Secret, API key waghera) kabhi chat me mat
bhejein** — sirf Admin Panel ke khane me khud dalein. Wahan wo encrypted
save hoti hain.

★ = is method me Auto Pay asal me ho sakta hai (provider confirmation
aati hai). Bina ★ wale methods Manual hi chalte hain — ye sach hai, koi
jhuti setting nahi.

---

## PayPal ★ (Manual ke liye sirf pehli cheez kaafi hai — Auto ke liye 3, 4, 5, 6 bhi)

1. **PayPal account email (receiving)** — Manual
   - Kahan: aapka apna PayPal account (paypal.com ya PayPal app).
   - Kis naam se: jis email se aapka PayPal account hai — player isi email
     par paisa bheje ga.
   - Khana: `PayPal account email (receiving)`

2. **Account name shown to sender** — Manual (marzi)
   - Kis naam se: aapke PayPal account ka business naam — player ko bhejte
     waqt yehi naam dikhta hai, taake use tasalli ho sahi jagah bhej raha hai.
   - Khana: `Account name shown to sender`

3. **Mode (Live / Sandbox)** — Auto ke liye
   - Pehle test karna ho to **Sandbox** chunein (nakli/test paisa), asal
     paisa ke liye **Live**. Neeche wali teeno cheezein USI tab se leni
     hain jo yahan chuna hai — Sandbox ki cheezein Live tab me nahi
     chaltin, aur Live ki Sandbox me nahi.
   - Khana: `Mode (Live / Sandbox)`

4. **Client ID** — Auto ke liye
   - Kahan jana hai: developer.paypal.com → Log in → **Apps & Credentials**
     → **Sandbox** ya **Live** wala tab (jo Mode upar chuna) → apni app
     kholein (na ho to Create App).
   - Kis naam se milega: **Client ID**
   - Khana: `Client ID`

5. **Secret** — Auto ke liye
   - Kahan: wohi app wali page, Client ID ke bilkul neeche.
   - Kis naam se milega: **Secret** (Show daba kar dikhta hai)
   - Khana: `Secret (client secret)`

6. **Webhook ID** — Auto ke liye (bhoolna mat — is ke bagair Auto ON nahi hoga)
   - Kahan: wohi app wali page, neeche **Webhooks** wala hissa.
   - Agar webhook pehle se na ho: **Add Webhook** → URL me ye dalen:
     `https://cash-pop-lottery.onrender.com/webhooks/paypal`
     → Event types me **Payment captures completed** aur
     **Payment captures refunded** tick karein → Save.
   - Kis naam se milega: us webhook ki line par uska **Webhook ID** (WH-
     se shuru hota hai).
   - Khana: `Webhook ID`

**Ye sab bharne ke baad kya hoga (Auto ka asal flow):** method ki page
par upar **Processing mode → Auto Pay** select karke Save karein. Phir:
player paisa bhej kar apna PayPal **Transaction ID** site par dalega →
site khud PayPal se pooch kar tasdeeq karegi (payment COMPLETED hai,
rakam + currency bilkul wohi hai, paisa AAP ke account ko gaya hai) →
tasdeeq par paisa khud credit. Agar player ID na bhi dale to PayPal ka
webhook aane par bhi wohi tasdeeq ho kar credit hota hai. Galat rakam,
galat currency, ya kisi aur ko gaya paisa — credit NAHI hoga, request
review queue me rahegi. Test pehle Sandbox se karein: Sandbox tab ki
Client ID/Secret/Webhook ID + Mode = Sandbox — site asal me PayPal ke
Sandbox server se hi baat karegi.

Note: PayPal ki purani "API Username / API Password / API Signature"
wali cheezein hamare kaam ki NAHI hain — wo purane (Classic) system ki
hain, unhein dhoondhne ki zarurat nahi.

## Crypto ★

1. **Asset** — Manual. Masalan BTC, USDT, ETH. Ek method = ek asset.
   Khana: `Asset (e.g. BTC, USDT, ETH)`
2. **Network** — Manual. Masalan Bitcoin, TRC20, ERC20 — asset ke sath
   wala network. Khana: `Network (e.g. Bitcoin, TRC20, ERC20)`
3. **Receiving wallet address** — Manual
   - Kahan: aapka apna wallet ya exchange app → usi asset + network par
     **Receive / Deposit** kholein.
   - Kis naam se: wahan jo lamba address dikhe.
   - Khana: `Receiving wallet address`
4. **Processor API key** — sirf Auto/API (agar koi processor istemal ho)
   - NOWPayments: Settings → Payments → API keys → **API Key**
   - Coinbase Commerce: Settings → API keys → **API Key**
   - Khana: `Processor API key`
5. **Processor webhook signing secret** — sirf Auto/API
   - NOWPayments ise **IPN Secret Key** kehta hai (Settings → Payments →
     Instant payment notifications).
   - Coinbase Commerce ise **Webhook Shared Secret** kehta hai.
   - Khana: `Processor webhook signing secret`

## Cards ★ (masalan Stripe)

1. **Card processor** — Stripe / Checkout.com / Other me se chunein.
   Khana: `Card processor`
2. **Publishable key** — Auto/API
   - Kahan: dashboard.stripe.com → **Developers → API keys**
   - Kis naam se: **Publishable key** (pk_ se shuru)
   - Khana: `Publishable key`
3. **Secret key** — Auto/API
   - Kahan: wohi page. Kis naam se: **Secret key** (sk_ se shuru)
   - Khana: `Secret key`
4. **Webhook signing secret** — Auto/API
   - Kahan: Stripe Dashboard → Developers → Webhooks → apna endpoint →
     **Signing secret** (whsec_ se shuru)
   - Khana: `Webhook signing secret`
5. **Mode** — Stripe me mode alag cheez nahi hoti: test keys (pk_test_)
   = sandbox, live keys (pk_live_) = asal paisa. Hamara Mode usi ke
   mutabiq chunein. Khana: `Mode`

Note: Cards ka Manual tareeqa aisa hai ke team player ko secure payment
link bhejt hai — is liye Manual ke liye koi receiving detail nahi
bharni. Player ko kabhi apna card number site par NAHI dalna.

## UPI

1. **Receiving UPI ID (VPA)** — Manual
   - Kahan: aapka UPI app (Google Pay / PhonePe / Paytm) → Profile.
   - Kis naam se: **UPI ID** ya **VPA** (masalan yourname@okhdfcbank) —
     dono ek hi cheez hai.
   - Khana: `Receiving UPI ID (VPA)`
2. **Verified name linked to this UPI ID** — Manual
   - Kis naam se: bilkul wohi naam jo bank ne is UPI ID ke sath register
     kiya hai — player ko paisa bhejne se pehle confirmation screen par
     yehi naam dikhta hai. Khud se koi naam na banayein.
   - Khana: `Verified name linked to this UPI ID`

## Pix ★ (Brazil)

1. **Pix key (receiving)** — Manual
   - Kahan: aapka bank app → Pix → **Minhas chaves Pix** (My Pix keys).
   - Kis naam se: **chave Pix** — CPF, CNPJ, email, phone ya random key.
   - Khana: `Pix key (receiving)` + type wala khana `Pix key type`
2. **Bank / payment institution (PSP)** — sirf agar koi gateway beech
   me ho; seedha apni key par lene ke liye khali chhorein.
3. **Provider API token / webhook signing secret** — sirf Auto/API, aur
   sirf usi gateway ke jo aap istemal karein. Pix (Banco Central) khud
   koi token nahi deta.

## Mobile Money ★ (masalan M-Pesa)

1. **Provider** — Manual. Masalan M-Pesa, MTN, Airtel.
   Khana: `Provider (M-Pesa, MTN, Airtel...)`
2. **Receiving type** — Manual. Teen me se ek chunein jo aapke number
   se milta ho: **paybill** (Pay Bill — Business Number), **till**
   (Buy Goods — Till Number), **mobile** (seedha mobile number).
   Khana: `Receiving type`
3. **Business Number / Till Number / mobile number** — Manual. Upar
   wale type ke mutabiq apna number.
   Khana: `Business Number / Till Number / mobile number`
   (Note: Paybill par player jo "Account Number" likhta hai wo USKA
   apna reference hota hai — aapko yahan nahi dalna.)
4. **Registered organisation / merchant name** — Manual. Bilkul wohi
   naam jo us number par register hai — player ko confirmation par
   yehi dikhta hai. Khana: `Registered organisation / merchant name`
5. **Provider API key / Consumer Key** — sirf Auto/API
   - M-Pesa (Daraja): developer.safaricom.co.ke → My Apps → **Consumer Key**
   - Khana: `Provider API key / Consumer Key`
6. **Webhook signing secret** — M-Pesa Daraja me ye cheez hoti hi nahi
   (wo Callback URL istemal karta hai) — M-Pesa ke liye khali chhorein.

## E-Wallets ★ (Skrill / NETELLER)

1. **Wallet** — Skrill / Neteller / Other chunein. Khana: `Wallet`
2. **Merchant account email / ID (receiving)** — Manual
   - Skrill: aapke merchant account ki processing email.
   - NETELLER: account email ya 12-digit Account ID.
   - Khana: `Merchant account email / ID (receiving)`
3. **Client ID** + **Client Secret** — sirf Auto/API, sirf NETELLER
   - Kahan: NETELLER merchant portal → Settings → Developer Settings →
     **API Keys**. Wahan **Client ID** aur **Client Secret** milte hain.
   - Skrill me ye dono cheezein hoti hi NAHI (Skrill Merchant ID +
     Secret Word istemal karta hai) — Skrill ho to khali chhorein.
4. **Merchant ID (Customer ID)** — sirf Skrill, Auto ke liye
   - Kahan: skrill.com par login → upar right corner me **apne naam par
     click** karein — wahan aapka **Customer ID** number dikhta hai
     (Skrill isi ko Merchant ID kehta hai; mobile app me profile icon
     ke neeche milta hai).
   - Khana: `Merchant ID (Customer ID)`
5. **Secret Word** — sirf Skrill, Auto ke liye (is ke bagair Skrill Auto ON nahi hoga)
   - Kahan: Skrill merchant account → **Settings → Developer Settings**
     → **Secret Word** (na set ho to wahan apna secret word set karein —
     ye aapke Skrill password se ALAG cheez hai).
   - Khana: `Secret Word`
   - Sath me ek kaam aur: jahan se aap Skrill payment link/session banate
     hain wahan **status_url** (notification URL) ye deni hai:
     `https://cash-pop-lottery.onrender.com/webhooks/skrill`
     Skrill har payment ki report isi URL par bhejta hai, Secret Word ki
     signature ke sath — site signature check kiye bagair credit nahi
     karti.
   - Ek sach ye bhi hai: jo player seedha apne Skrill wallet se aapke
     email par "send money" kare ga, us ki koi report Skrill NAHI bhejta
     (report sirf payment link/session wali payment par aati hai) — aisi
     deposit hamesha ki tarah manual queue me rahe gi, wahan aap apne
     Skrill account me dekh kar approve karein ge.

## Apple Pay ★

Sach: Apple khud koi API key NAHI deta — paisa hamesha kisi processor
(Stripe waghera) se guzarta hai.

1. **Apple merchant ID** — Manual/config
   - Kahan: developer.apple.com → Certificates, Identifiers & Profiles
     → **Merchant IDs**. Kis naam se: **Merchant ID** (merchant. se shuru)
   - Khana: `Apple merchant ID`
2. **Payment processor** — jo PSP aapke liye Apple Pay process kare.
   Khana: `Payment processor`
3. **Processor API key** — sirf Auto/API — usi processor ki key (Stripe
   ho to Developers → API keys wali Secret key). Khana: `Processor API key`
4. **Processor webhook signing secret** — sirf Auto/API — processor ke
   Webhooks wale hisse se. Khana: `Processor webhook signing secret`

## Google Pay ★

1. **Google Pay merchant ID** — config
   - Kahan: Google Pay & Wallet Console (pay.google.com/business/console)
     — upar right me merchant ID dikhta hai. Sirf PRODUCTION ke liye
     zaruri, aur Google ki approval ke baad milta hai.
   - Khana: `Google Pay merchant ID`
2. **Merchant name** — jo naam Google Pay wali sheet par dikhe.
   Khana: `Merchant name`
3. **Gateway name** + **Gateway merchant ID** — gateway = masalan
   stripe; gateway merchant ID = usi gateway par aapka account ID.
   Khanay: `Gateway name`, `Gateway merchant ID`
4. **Environment** — TEST (test cards) ya PRODUCTION (asal paisa).
   Khana: `Environment`
5. **Gateway webhook signing secret** — sirf Auto/API. Google Pay ka
   apna koi webhook secret NAHI hota — ye GATEWAY ka signing secret
   hai. Khana: `Gateway webhook signing secret`

## Samsung Pay ★

Sach: Samsung ke apne documents ke mutabiq **Service ID hi aapki
Merchant ID hai** — doosri koi merchant ID dhoondhne ki zarurat nahi.
Samsung khud koi API key bhi nahi deta — paisa processor se guzarta hai.

1. **Service ID (your Samsung merchant ID)** — config
   - Kahan: Samsung Pay Developers portal — service banane par milta hai.
   - Khana: `Service ID (your Samsung merchant ID)`
2. **Payment processor** — jo PSP Samsung Pay process kare.
   Khana: `Payment processor`
3. **Processor API key** / **Processor webhook signing secret** — sirf
   Auto/API, processor ke apne dashboard se.

## Bank Transfer

Do shakal me se jo aapke account par lage, wahi bharein — dono nahi:

**Agar account IBAN wala hai (Europe waghera):**

1. **IBAN** — Manual. Kahan: banking app → account details.
   Khana: `IBAN` (IBAN ke sath alag routing code NAHI chahiye.)
2. **Bank name** + **Account holder name** — Manual. Naam bilkul
   account wala (ise beneficiary name bhi kehte hain).
3. **SWIFT / BIC code** — sirf international transfers ke liye.

**Agar account IBAN wala NAHI (US / UK / India waghera):**

1. **Account number (non-IBAN countries)** — Manual.
   Khana: `Account number (non-IBAN countries)`
2. **US routing number (ABA)** — sirf US ke liye: 9 digits wala ABA
   Routing Transit Number (cheque par ya app → account details me).
3. **Local routing code** — UK sort code / India IFSC / Australia BSB —
   sirf agar aapke mulk me lagta ho. Khana: `Local routing code (sort code / IFSC / BSB)`

## QR Pay

1. **Network / scheme for this QR** — Manual. Masalan PromptPay /
   Thai QR, DuitNow QR, QRIS. Khana: `Network / scheme for this QR`
2. **Payee ID inside the QR** — Manual, sab se zaruri
   - PromptPay ke liye: mobile number, citizen/tax ID, e-Wallet ID ya
     bank account number — jo ID aapke QR ke andar hai.
   - Ye is liye zaruri hai ke agar QR image kabhi fail ho jaye to
     player isi ID par haath se paisa bhej sakta hai.
   - Khana: `Payee ID inside the QR (PromptPay ID / account)`
3. **QR code image URL** — Manual. Banking app (My QR) se banaya gaya
   QR ya bank ka diya placard — usi Payee ID ka ho.
   Khana: `QR code image URL`
4. **Recipient name** — jo naam player ko confirmation screen par
   dikhe. Khana: `Recipient name (shown to payer on confirmation)`

## Vouchers

1. **Voucher issuer** — Manual. Jis company/brand ke vouchers aapne
   khareede hain — player ko BHI usi issuer ka voucher khareedna hoga.
   Khana: `Voucher issuer`
   (Koi API key nahi hai isme — PIN haath se check hota hai.)

## Cash Agents

1. **Agent network name** — Manual. Aapke agent network ka naam.
   Khana: `Agent network name`
2. **Agent instructions** — Manual. Kahan/kese paisa dena hai (agent
   ka naam, jagah, phone, time) — ye player ko dikhta hai.
   Khana: `Agent instructions`

---

## Currencies — doosri currency ke players ke liye (masalan INR, EUR)

Sirf method on kar dena kaafi nahi — player jis currency ko choose
karega, us currency ka method bhi hona chahiye, warna use doosri
currency ke methods dikhenge. Admin panel Settings → Currencies me har
currency ke liye "coverage warning" bhi aati hai agar uska method na ho.

Masalan **INR players** ke liye aapko ye chahiye:

- [ ] Settings → Currencies me INR **Enabled** ho aur uska **Rate** asal
      rate ho (1 USD = kitne INR — ye rate aap khud set karte hain;
      site koi live market rate nahi leti).
- [ ] Kam se kam **ek INR deposit method** — masalan UPI method bana
      kar uski currency INR kar dein aur apni UPI ID (VPA) bhar dein.
- [ ] Kam se kam **ek INR withdrawal method** — wohi UPI method "both"
      bhi ho sakta hai.

EUR ya kisi aur currency ke liye bhi yehi teen cheezein: currency
enabled + rate, ek deposit method us currency me, ek withdrawal method
us currency me.

Note: Player apni currency header me "My currency" se choose karta
hai. Uske deposit/withdrawal pages par usi currency ke methods pehle
aayenge; doosri currency ke methods alag "Other currencies" me
currency ke naam ke sath dikhenge. Player apne wallets ke darmiyan
**Exchange** bhi kar sakta hai — rate wahi hota hai jo aapne Settings →
Currencies me set kiya (admin-set rate); exchange fee agar rakhna ho
to wahi card par "Wallet exchange fee (%)" me set hota hai (default 0).

Ek zaruri baat: Currencies wali list me kisi currency ko OFF karne se
wo list se NIKAL jati hai (site ke record me "enabled" alag se save
nahi hota — list me hona hi enabled hona hai). Dobara on karna ho to
usi card ki khali line me code, symbol aur rate likh kar save kar dein.

---

## Login aur verification channels — Email, SMS, Google, Facebook

Ye cheezein Render ke **Environment** me lagti hain (admin panel me
nahi). Admin panel → Security page par "Login & verification health"
card me har channel ke samne CONFIGURED ya NOT CONFIGURED dikhta hai.
Jo channel configured nahi, wo player ko saaf mana karta hai (jhuti
"code bhej diya" kabhi nahi kehta) — ye design hai, bug nahi. Wahi
page par "Send test email" / "Send test SMS" button se pehle khud
test kar sakte hain.

### Email (OTP, verification link, password reset — sab isi se jata hai)

Gmail wala asaan rasta:

- [ ] `SMTP_HOST` = smtp.gmail.com
- [ ] `SMTP_PORT` = 587
- [ ] `SMTP_USER` = aapka apna Gmail address
- [ ] `SMTP_PASS` = Google **App Password** (16 hisson wala code) — ye
      aapka aam Gmail password NAHI hai. Banane ki jagah:
      myaccount.google.com → Security → 2-Step Verification on karein
      → phir "App passwords" me ja kar ek bana lein, wahi yahan lagayein.
- [ ] `SMTP_FROM` = wahi Gmail address

Note: muft Gmail se roz takreeban 500 email ki had hai. Baad me domain
aane par domain wali email lag jayegi.

### SMS (Phone OTP)

Do raaste hain — ek chunein:

**Twilio (asal/paid — real users ke liye yehi theek hai):**

- [ ] Twilio account bana kar ek phone number khareedein.
- [ ] `TWILIO_SID` = Twilio Console ke home page par "Account SID"
- [ ] `TWILIO_TOKEN` = wahi page par "Auth Token"
- [ ] `TWILIO_FROM` = jo number aapne khareeda (e.g. +1...)
- [ ] Admin panel → Notifications → SMS provider me "Twilio" chunein
      (ya Render env me `SMS_PROVIDER` = twilio).

**TextBelt (sab se sasta test rasta — muft key bohat limited hai):**

- [ ] `TEXTBELT_KEY` = textbelt.com se li hui key (muft key din me
      bohat kam SMS deti hai — sirf test ke liye).
- [ ] Provider "TextBelt" chunein (ya `SMS_PROVIDER` = textbelt).

### Google sign-in (Gmail se login)

- [ ] Google Cloud Console → APIs & Services → Credentials → "Create
      credentials" → OAuth client ID → type: **Web application**.
- [ ] "Authorized redirect URIs" me bilkul yehi likhein:
      **https://cash-pop-lottery.onrender.com/auth/google/callback**
- [ ] Wahan mile **Client ID** ko `GOOGLE_CLIENT_ID` aur **Client
      Secret** ko `GOOGLE_CLIENT_SECRET` me Render env me lagayein.
- [ ] Admin panel → Settings → Toggles me "Google sign-in" ON karein.

### Facebook sign-in

- [ ] developers.facebook.com → My Apps → app banayein → Facebook
      Login → Settings → "Valid OAuth Redirect URIs" me ye likhein:
      **https://cash-pop-lottery.onrender.com/auth/facebook/callback**
- [ ] App ID ko `FACEBOOK_APP_ID` aur App Secret ko
      `FACEBOOK_APP_SECRET` me Render env me lagayein.
- [ ] Admin panel → Settings → Toggles me "Facebook sign-in" ON karein.
