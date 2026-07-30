/**
 * Blog content. Plain data so the index and post pages stay simple and the copy
 * follows the same rules as the rest of the site (no AI-tell punctuation, Title
 * Case headings, sentence-case body, real stablecoins). Covers are generated
 * from each post's accent color (see BlogCover).
 */

export type BlogSection = { heading: string; body: string[] }

export type BlogAuthor = { name: string; role: string }

/** The parts of a post that change between languages. Everything else (slug,
 *  accent, seed, date) is deliberately shared so the two versions stay one post
 *  with two renderings rather than drifting into two separate articles. */
export type BlogTranslation = {
  title: string
  excerpt: string
  chain: string
  readingTime: string
  sections: BlogSection[]
}

export type BlogPost = {
  slug: string
  title: string
  excerpt: string
  /** Topic label shown as a chip. */
  chain: string
  /** Cover and chip accent color, chosen for contrast and brand harmony. */
  accent: string
  date: string
  readingTime: string
  seed: number
  author: BlogAuthor
  sections: BlogSection[]
  /** Turkish rendering. Absent means this post has not been translated yet, and
   *  the Turkish index simply will not list it rather than showing English copy
   *  under a Turkish URL, which is the thing that gets a site penalised. */
  tr?: BlogTranslation
}

export type Lang = 'en' | 'tr'

/** A post as it should render in one language. Falls back to nothing: callers
 *  check `hasTranslation` first, because a half-translated page is worse than
 *  an absent one for both readers and search engines. */
export function localized(post: BlogPost, lang: Lang): BlogTranslation {
  if (lang === 'tr' && post.tr) return post.tr
  return {
    title: post.title,
    excerpt: post.excerpt,
    chain: post.chain,
    readingTime: post.readingTime,
    sections: post.sections,
  }
}

export const hasTranslation = (post: BlogPost, lang: Lang): boolean =>
  lang === 'en' ? true : Boolean(post.tr)

/** Posts available in a language, newest first as authored. */
export const postsIn = (lang: Lang): BlogPost[] => POSTS.filter((p) => hasTranslation(p, lang))

/** The path a post lives at in a given language. */
export const postPath = (slug: string, lang: Lang): string =>
  lang === 'tr' ? `/tr/blog/${slug}` : `/blog/${slug}`

/**
 * hreflang alternates for a post. Every version lists every version including
 * itself; an incomplete cluster is ignored wholesale rather than partially
 * honoured. `x-default` points at English as the version to serve when no
 * language matches.
 */
export function alternatesFor(post: BlogPost): { hreflang: string; href: string }[] {
  const base = 'https://a-identity.xyz'
  const out = [
    { hreflang: 'en', href: `${base}/blog/${post.slug}` },
    { hreflang: 'x-default', href: `${base}/blog/${post.slug}` },
  ]
  if (post.tr) out.splice(1, 0, { hreflang: 'tr', href: `${base}/tr/blog/${post.slug}` })
  return out
}

/** Team bylines; posts rotate between the two tracks. */
export const AUTHORS = {
  protocol: { name: 'A-Identity Team', role: 'Protocol Engineering' },
  devrel: { name: 'A-Identity Team', role: 'Developer Relations' },
} as const

export const POSTS: BlogPost[] = [
  {
    slug: 'verify-an-agent-before-you-pay-it',
    title: 'How to verify an AI agent before you pay it',
    excerpt:
      'Your agent is about to send money to another agent. You have one question and a few hundred milliseconds to answer it. Here is what to check, in what order, and what each answer is actually worth.',
    chain: 'Trust',
    accent: '#2F6F4F',
    date: 'Jul 31, 2026',
    readingTime: '7 min read',
    seed: 11,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'The question is not "is this agent good"',
        body: [
          'When your agent is about to pay another agent, the useful question is never "is this counterparty trustworthy" in the abstract. It is "should this specific payment, for this amount, to this party, right now, go through". Those are different questions and only the second one has an answer you can act on.',
          'The difference matters because risk is a function of exposure. A counterparty you would happily pay one dollar is not automatically a counterparty you should pay ten thousand. Any check that returns a verdict without knowing the amount is answering a question you did not ask.',
        ],
      },
      {
        heading: 'Check one: is there an identity at all',
        body: [
          'Start with whether the counterparty is registered on-chain. Under ERC-8004, an agent has an entry in an identity registry: a token id, an owner, and metadata describing its endpoints. This is cheap to check and cheap to fake, so treat it as a filter rather than a signal. An agent with no registration is a stranger. An agent with one is a stranger who filled in a form.',
          'What you are ruling out here is the trivial case, and that is worth doing first because it is the fastest check you will run.',
        ],
      },
      {
        heading: 'Check two: has it proved it controls its own wallet',
        body: [
          'This is the check most people skip and it is the one that separates a claim from evidence. Anyone can register an agent that lists a wallet address. Proving that the agent actually controls that address requires signing a challenge with the corresponding key, and recording the result on-chain.',
          'That is what KYA, Know Your Agent, means: not a background check on the operator, but a cryptographic demonstration that the agent and the wallet are the same actor. Without it, an attacker can register an agent claiming a reputable wallet and inherit its history for free.',
          'When you read a reputation score, ask what it was computed over. If the underlying wallet was never proved, the score describes somebody else.',
        ],
      },
      {
        heading: 'Check three: what has it actually done',
        body: [
          'Now reputation becomes meaningful. The number you want is one computed from settled payments, not from ratings. Ratings are cheap to manufacture; a settlement is a transaction that moved real value and left a hash behind.',
          'Two properties make a score usable. It should be deterministic, so the same inputs always produce the same number and you can recompute it yourself rather than trusting ours. And it should decay, so an agent that behaved well a year ago and has been silent since does not read the same as one that behaved well last week.',
          'Ask any scoring provider for their method. If they will not publish it, the score is a brand, not a measurement.',
        ],
      },
      {
        heading: 'Check four: is the deal itself suspicious',
        body: [
          'Everything above examines one party. Some of the most common manipulation is only visible when you look at both.',
          'The pattern is simple: an operator registers two agents, has them pay each other repeatedly, and manufactures a settlement history for both. Each agent looks fine in isolation. The relationship between them is the tell, and a one-sided scan cannot see it by construction.',
          'So the last check takes both sides of the proposed deal and asks whether they are independent. Shared funding sources, shared deployment patterns, and payment graphs that only ever loop back on themselves are what give it away.',
        ],
      },
      {
        heading: 'What a verdict should look like',
        body: [
          'The output of all this should be a decision, not a dashboard. Your agent cannot act on a risk score of 0.72. It can act on ALLOW, WARN or DENY.',
          'WARN is the important one and it is usually missing. It means the payment is permitted but crosses a line where a human should look. An agent that treats WARN as ALLOW has thrown away the only signal that was asking for a person.',
          'Whatever verdict you get, it should arrive with reasons in plain language. You will eventually have to explain a blocked payment to whoever was expecting it to go through, and "the model said no" is not an explanation.',
        ],
      },
      {
        heading: 'The check that runs after the verdict',
        body: [
          'Verifying the counterparty answers whether you should pay. It does not answer whether you are allowed to. Those are separate, and conflating them is how agents overspend while passing every check.',
          'A counterparty can be entirely legitimate and the payment can still be outside the budget its owner set. That limit needs to live somewhere the agent cannot argue with: a server-side pre-check is convenient, but an on-chain vault that reverts an over-limit transfer is what still holds when the server is wrong.',
          'Verify the other party, then check your own limits. Skipping the second one means the only thing standing between an agent and your balance is its own judgement.',
        ],
      },
      {
        heading: 'Doing it in one call',
        body: [
          'A-Identity runs these four checks as pay-per-call endpoints. `risk_check` takes the counterparty and the intended amount and returns the verdict with its reasons. `counterparty_check` takes both sides and catches the self-dealing case. `trust_preview` is free and rate limited, so you can see the shape of an answer before spending anything.',
          'Payment is per call in USDC over x402, which means no account and no API key: an unpaid request returns HTTP 402 describing exactly what is owed, and the resource is served on a paid retry.',
          'The scoring method is published in full and every settlement we have taken is listed with its transaction hash. You should not have to trust a trust provider, and we would rather be checked than believed.',
        ],
      },
    ],
    tr: {
      title: 'Bir AI ajanına ödeme yapmadan önce kimliğini nasıl doğrularsınız',
      excerpt:
        'Ajanınız başka bir ajana para göndermek üzere. Cevaplamanız gereken tek bir soru ve birkaç yüz milisaniyeniz var. Neye, hangi sırayla bakmalı ve her cevap gerçekte ne kadar değerli.',
      chain: 'Güven',
      readingTime: '7 dakika',
      sections: [
        {
          heading: 'Soru "bu ajan iyi mi" değil',
          body: [
            'Ajanınız başka bir ajana ödeme yapmak üzereyken işe yarayan soru, soyut olarak "bu karşı taraf güvenilir mi" değildir. "Bu belirli ödeme, bu tutarda, bu tarafa, şu anda gerçekleşmeli mi" sorusudur. Bunlar farklı sorulardır ve yalnızca ikincisinin üzerine harekete geçebileceğiniz bir cevabı vardır.',
            'Fark önemli, çünkü risk maruziyetin bir fonksiyonudur. Bir dolar ödemekte tereddüt etmeyeceğiniz bir karşı taraf, otomatik olarak on bin dolar ödemeniz gereken bir karşı taraf değildir. Tutarı bilmeden karar döndüren her kontrol, sormadığınız bir soruyu cevaplıyordur.',
          ],
        },
        {
          heading: 'Birinci kontrol: ortada bir kimlik var mı',
          body: [
            'Karşı tarafın zincir üzerinde kayıtlı olup olmadığıyla başlayın. ERC-8004 kapsamında bir ajanın kimlik kaydında bir girdisi bulunur: bir token kimliği, bir sahip ve uçlarını tarif eden meta veri. Bunu kontrol etmek de taklit etmek de ucuzdur, dolayısıyla bunu bir sinyal değil bir filtre olarak görün. Kaydı olmayan bir ajan yabancıdır. Kaydı olan bir ajan, form doldurmuş bir yabancıdır.',
            'Burada elediğiniz şey en basit durumdur ve bunu ilk yapmaya değer, çünkü çalıştıracağınız en hızlı kontrol budur.',
          ],
        },
        {
          heading: 'İkinci kontrol: kendi cüzdanını kontrol ettiğini kanıtladı mı',
          body: [
            'Bu, çoğu kişinin atladığı kontroldür ve iddiayı kanıttan ayıran şey tam olarak budur. Herkes bir cüzdan adresi listeleyen bir ajan kaydedebilir. Ajanın o adresi gerçekten kontrol ettiğini kanıtlamak ise ilgili anahtarla bir meydan okumayı imzalamayı ve sonucu zincire yazmayı gerektirir.',
            'KYA, yani Know Your Agent, budur: operatör hakkında bir geçmiş araştırması değil, ajan ile cüzdanın aynı aktör olduğunun kriptografik gösterimi. Bu olmadan bir saldırgan, itibarlı bir cüzdanı sahiplendiğini iddia eden bir ajan kaydedip o geçmişi bedavaya devralabilir.',
            'Bir itibar skoru okuduğunuzda, neyin üzerinden hesaplandığını sorun. Altındaki cüzdan hiç kanıtlanmadıysa skor başka birini tarif ediyordur.',
          ],
        },
        {
          heading: 'Üçüncü kontrol: gerçekte ne yapmış',
          body: [
            'İtibar ancak burada anlam kazanır. İstediğiniz sayı, puanlamalardan değil, tamamlanmış ödemelerden hesaplanan sayıdır. Puanlama üretmek ucuzdur; bir settlement ise gerçek değer taşımış ve arkasında bir işlem özeti bırakmış bir işlemdir.',
            'Bir skoru kullanılabilir kılan iki özellik var. Deterministik olmalı ki aynı girdiler her zaman aynı sayıyı üretsin ve bize güvenmek yerine kendiniz yeniden hesaplayabilesiniz. Ve zamanla azalmalı ki bir yıl önce iyi davranıp o zamandan beri susan bir ajan, geçen hafta iyi davranan bir ajanla aynı görünmesin.',
            'Skor sağlayan herkesten yöntemini isteyin. Yayınlamıyorlarsa o skor bir ölçüm değil, bir markadır.',
          ],
        },
        {
          heading: 'Dördüncü kontrol: anlaşmanın kendisi şüpheli mi',
          body: [
            'Yukarıdakilerin hepsi tek bir tarafı inceler. En yaygın manipülasyonların bazıları ise ancak iki tarafa birden bakınca görünür.',
            'Kalıp basit: bir operatör iki ajan kaydeder, onlara birbirlerine tekrar tekrar ödeme yaptırır ve ikisi için de settlement geçmişi imal eder. Her ajan tek başına bakıldığında düzgün görünür. Aradaki ilişki ele veren şeydir ve tek taraflı bir tarama bunu yapısı gereği göremez.',
            'Bu yüzden son kontrol, önerilen anlaşmanın iki tarafını birden alıp bağımsız olup olmadıklarını sorar. Ortak fonlama kaynakları, ortak dağıtım kalıpları ve sürekli kendi üzerine kapanan ödeme grafikleri bunu ele verir.',
          ],
        },
        {
          heading: 'Bir karar nasıl görünmeli',
          body: [
            'Tüm bunların çıktısı bir gösterge paneli değil, bir karar olmalı. Ajanınız 0.72 risk skoruyla hareket edemez. ALLOW, WARN veya DENY ile edebilir.',
            'Önemli olan WARN ve genellikle eksik olan da odur. Ödemeye izin verildiği ama bir insanın bakması gereken bir çizgiyi geçtiği anlamına gelir. WARN kararını ALLOW gibi işleyen bir ajan, elindeki tek "insan çağır" sinyalini çöpe atmış olur.',
            'Hangi kararı alırsanız alın, yanında sade bir dille gerekçeler gelmeli. Er ya da geç, engellenmiş bir ödemeyi o ödemenin geçmesini bekleyen birine açıklamak zorunda kalacaksınız ve "model hayır dedi" bir açıklama değildir.',
          ],
        },
        {
          heading: 'Karardan sonra çalışan kontrol',
          body: [
            'Karşı tarafı doğrulamak, ödeme yapmalı mısınız sorusunu cevaplar. Ödeme yapmaya izniniz var mı sorusunu cevaplamaz. Bunlar ayrı şeylerdir ve ikisini birbirine karıştırmak, ajanların her kontrolü geçerken bütçeyi aşmasının yoludur.',
            'Bir karşı taraf tamamen meşru olabilir ve ödeme yine de sahibinin koyduğu bütçenin dışında kalabilir. O sınırın, ajanın tartışamayacağı bir yerde durması gerekir: sunucu tarafındaki ön kontrol pratiktir, ama sunucu yanıldığında hâlâ ayakta duran şey, limit aşan transferi geri çeviren zincir üstü kasadır.',
            'Önce karşı tarafı doğrulayın, sonra kendi limitlerinizi kontrol edin. İkincisini atlamak, bir ajanla bakiyeniz arasında duran tek şeyin ajanın kendi muhakemesi olması demektir.',
          ],
        },
        {
          heading: 'Bunu tek çağrıda yapmak',
          body: [
            'A-Identity bu dört kontrolü çağrı başına ödemeli uçlar olarak sunar. `risk_check` karşı tarafı ve amaçlanan tutarı alır, kararı gerekçeleriyle döndürür. `counterparty_check` iki tarafı birden alır ve kendi kendine ticaret durumunu yakalar. `trust_preview` ücretsiz ve hız sınırlıdır, böylece hiçbir şey harcamadan cevabın nasıl göründüğünü görebilirsiniz.',
            'Ödeme, x402 üzerinden USDC ile çağrı başınadır: hesap yok, API anahtarı yok. Ödenmemiş bir istek, tam olarak ne borçlu olduğunuzu anlatan HTTP 402 döner ve kaynak ödenmiş tekrar denemede sunulur.',
            'Skorlama yöntemi tamamıyla yayında ve aldığımız her settlement işlem özetiyle birlikte listeleniyor. Bir güven sağlayıcısına güvenmek zorunda kalmamalısınız; bize inanılmasındansa kontrol edilmeyi tercih ederiz.',
          ],
        },
      ],
    },
  },
  {
    slug: 'agentic-economy-when-agents-get-wallets',
    title: 'The Agentic Economy: when agents get wallets',
    excerpt:
      'Jeremy Allaire and Circle describe an internet where AI agents hold wallets and transact in stablecoins. Before that economy can run, agents need a way to trust each other. That is the part we build.',
    chain: 'Agentic Economy',
    accent: '#7342E2',
    date: 'Jul 17, 2026',
    readingTime: '4 min read',
    seed: 8,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'When assistants get wallets',
        body: [
          'Circle CEO Jeremy Allaire has laid out the same future many of us now see coming: AI assistants stop being tools you type into and become economic actors. They hold their own stablecoin wallets, hire other agents, buy data and compute, and settle on-chain without a human clicking through every step.',
          'That is the agentic economy. It is not a metaphor once an agent can pay for a thing on its own, and stablecoins on fast chains are what make those payments real.',
        ],
      },
      {
        heading: 'The missing primitive is trust',
        body: [
          'Give an agent a wallet and it can pay. It still cannot answer the one question that has to come first: is the counterparty on the other side of this transaction who it claims to be, and is it safe to pay?',
          'Humans answer that with reputation, brands, and years of context. An agent transacting at machine speed has none of that. Without a trust layer, the agentic economy is a market of strangers moving money to strangers.',
        ],
      },
      {
        heading: 'A passport before a wallet',
        body: [
          'A-Identity is that trust layer. Before an agent-to-agent transaction, an agent calls us to verify the counterparty: an on-chain ERC-8004 identity, a deterministic reputation score from real settled activity, and a pre-transaction risk check that returns allow, warn, or deny.',
          'Identity and reputation are the picks and shovels of this economy. They are boring in the way plumbing is boring, and just as load-bearing.',
        ],
      },
      {
        heading: 'Live, not a whitepaper',
        body: [
          'This is running today. A-Identity is listed on OKX.AI as an agent service other agents call and pay per use, with x402 settling each call in stablecoins on X Layer, and real on-chain settlements you can verify.',
          'The agentic economy will be built on money that moves at machine speed. It will only be worth building if trust moves that fast too.',
        ],
      },
    ],
  },
  {
    slug: 'gas-in-usdc-why-arc',
    title: 'Gas in USDC: why agents settle on Arc',
    excerpt:
      'On most chains an agent needs a second, volatile token just to pay fees. Arc removes that. Here is why it matters for machine payments.',
    chain: 'Arc',
    accent: '#2775CA',
    date: 'Jun 16, 2026',
    readingTime: '4 min read',
    seed: 0,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'The hidden tax of gas tokens',
        body: [
          'To send a dollar on a normal chain, an agent also needs a little of a second token for gas. It has to hold that token, price it, and refill it before it runs out.',
          'That is one more moving part that can break, at exactly the moment a payment needs to go through.',
        ],
      },
      {
        heading: 'Arc pays fees in USDC',
        body: [
          'Arc is an EVM chain where gas is paid in USDC, the same dollar the agent is already moving. No second token, no surprise volatility, no refill dance.',
          'For software that just wants to pay for a thing, this is the difference between simple and fragile.',
        ],
      },
      {
        heading: 'Sub-second and deterministic',
        body: [
          'Blocks settle in well under a second, with deterministic finality. The payment either happened or it did not, and the agent knows right away.',
          'For an agent making thousands of small calls, that certainty is the difference between fluid and stuck.',
        ],
      },
      {
        heading: 'What we use it for',
        body: [
          'Arc is our primary rail. It carries the unified balance through Circle App Kit and nanopayments down to a millionth of a dollar.',
          'Anything large still pauses for a human. Speed never means losing the tower.',
        ],
      },
    ],
  },
  {
    slug: 'unified-balance-one-usdc-every-chain',
    title: 'Unified balance: one USDC, every chain',
    excerpt:
      'Your agent\'s money should not be trapped on the chain it happened to land on. Circle App Kit gives it one spendable balance.',
    chain: 'Arc',
    accent: '#2775CA',
    date: 'Jun 12, 2026',
    readingTime: '4 min read',
    seed: 1,
    author: AUTHORS.devrel,
    sections: [
      {
        heading: 'The fragmentation problem',
        body: [
          'Funds scatter. A hundred USDC sits on Base, thirty-five on Arbitrum, and none on the chain where the agent needs to pay right now.',
          'Bridging across is slow, easy to get wrong, and a bad place for an autonomous process to improvise.',
        ],
      },
      {
        heading: 'One balance, many chains',
        body: [
          'Circle Gateway pools USDC from several chains into a single balance. The agent sees one number and can spend it on any supported chain, in one step.',
          'No manual bridge, no waiting for a wrapped token to arrive.',
        ],
      },
      {
        heading: 'How it works in A-Identity',
        body: [
          'Deposit from any chain into the unified balance, then spend on Arc or Base instantly. We show the breakdown, so you always see where the money came from.',
          'It reads like a bank account that happens to span five networks.',
        ],
      },
      {
        heading: 'The human stays in the tower',
        body: [
          'Deposits and spends above your limit pause for approval. Convenience never means handing over the keys.',
          'The agent gets reach. You keep the final say.',
        ],
      },
    ],
  },
  {
    slug: 'base-where-agents-meet-money',
    title: 'Base: where agents meet money',
    excerpt:
      "Coinbase's L2 quietly became the default home for on-chain dollars. That makes it the natural meeting point for paying agents.",
    chain: 'Base',
    accent: '#0052FF',
    date: 'Jun 9, 2026',
    readingTime: '4 min read',
    seed: 2,
    author: AUTHORS.devrel,
    sections: [
      {
        heading: 'Dollars live here',
        body: [
          'Base has deep USDC liquidity and a large builder community. Where the money and the developers gather, agents follow.',
          'You do not start a market. You go to where one already is.',
        ],
      },
      {
        heading: 'Cheap enough for micro-payments',
        body: [
          'Fees on Base are low enough that a fraction-of-a-cent payment makes sense. That is the unit agents trade in: small, frequent, automatic.',
          'A rail that makes tiny payments uneconomic is no rail for agents at all.',
        ],
      },
      {
        heading: "x402's reference rail",
        body: [
          'The x402 payment standard grew up on Base. Paying per request, in USDC, with no account and no API key, works here today, not in theory.',
          'That maturity is why we treat Base as the proving ground for the pay side.',
        ],
      },
      {
        heading: 'ERC-8004 native',
        body: [
          'Agent identity is an Ethereum standard, and Base speaks Ethereum. The same passport works with no translation layer.',
          'Identity on one EVM chain is identity on all of them.',
        ],
      },
    ],
  },
  {
    slug: 'x402-on-base-pay-per-request',
    title: 'x402 on Base: paying per request, for real',
    excerpt:
      "HTTP has carried a '402 Payment Required' status code, unused, for thirty years. On Base it finally means something.",
    chain: 'Base',
    accent: '#0052FF',
    date: 'Jun 5, 2026',
    readingTime: '3 min read',
    seed: 3,
    author: AUTHORS.devrel,
    sections: [
      {
        heading: 'A status code waiting for a use',
        body: [
          'The number 402 was reserved in the HTTP spec and left empty. Nobody had a fast, cheap way to actually charge per request.',
          'Stablecoins on a low-fee chain changed the math, and the empty slot finally has a job.',
        ],
      },
      {
        heading: 'Payment rides with the request',
        body: [
          'The agent calls your API and gets a 402 back with a price. It pays in USDC, and the call goes through. No signup, no key, no invoice later.',
          'The payment is part of the request, not a separate errand.',
        ],
      },
      {
        heading: 'Why it fits agents',
        body: [
          'Agents do not fill in checkout forms. They make calls. Pricing the call itself is the natural shape of machine commerce.',
          'Human commerce is a cart and a checkout. Agent commerce is a request and a receipt.',
        ],
      },
      {
        heading: 'Try it',
        body: [
          'Our SDK wraps any MCP tool as a paid tool in a few lines. The same flow runs on Arc when you want gas paid in USDC too.',
          'Write the handler once, charge for it everywhere.',
        ],
      },
    ],
  },
  {
    slug: 'bridging-agent-identity-to-stellar',
    title: 'Bridging agent identity to Stellar',
    excerpt:
      'Stellar moves dollars cheaply and fast, but it is not EVM. Here is how an agent passport reaches it anyway.',
    chain: 'Stellar',
    accent: '#E0B23C',
    date: 'May 30, 2026',
    readingTime: '3 min read',
    seed: 4,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'Why Stellar at all',
        body: [
          'USDC and EURC are native on Stellar, issued by Circle. Fees are tiny and settlement is quick.',
          'For agents paying across currencies, that combination is hard to beat.',
        ],
      },
      {
        heading: 'Identity is the catch',
        body: [
          'ERC-8004 is an Ethereum standard, so it does not exist natively on Stellar. The agent still needs to prove who it is before anyone trusts it.',
          'A fast payment rail with no identity is half a system.',
        ],
      },
      {
        heading: 'Bridged, not faked',
        body: [
          'The agent carries one ERC-8004 passport on an EVM chain. On Stellar we anchor it through a Soroban registry and SEP-10 auth, so the same identity holds.',
          'It is the real passport, recognized in a new country, not a fresh fake one.',
        ],
      },
      {
        heading: 'One agent, many homes',
        body: [
          'The goal is a single reputation that travels, whether the agent settles on Arc, Base, or Stellar.',
          'Your track record should follow you, not reset at every border.',
        ],
      },
    ],
  },
  {
    slug: 'watching-monad-parallel-evm',
    title: 'Watching Monad: parallel EVM for agent throughput',
    excerpt:
      'If a million agents transact at once, the chain underneath has to keep up. Monad is one bet on how.',
    chain: 'Monad',
    accent: '#836EF9',
    date: 'May 18, 2026',
    readingTime: '3 min read',
    seed: 6,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'The throughput wall',
        body: [
          "Today's EVM chains run transactions one after another. Pack in enough agents and they queue. Fees spike and latency grows.",
          'A busy agent economy can hit that wall fast.',
        ],
      },
      {
        heading: 'Run them in parallel',
        body: [
          'Monad is an EVM-compatible L1 that executes independent transactions in parallel, aiming for much higher throughput while keeping the familiar tooling.',
          'Same language, more lanes on the road.',
        ],
      },
      {
        heading: 'Same code, more room',
        body: [
          'Because it is EVM-compatible, ERC-8004 identity and x402 payments port over with little change. That is what makes it worth a close look.',
          'We would rather extend the stack than rebuild it.',
        ],
      },
      {
        heading: 'On our radar',
        body: [
          'Monad is early. We are watching it as a future high-throughput rail, not shipping on it yet.',
          'Honesty over hype: we name what is live, and what is still a bet.',
        ],
      },
    ],
  },
  {
    slug: 'know-your-agent-identity-before-money',
    title: 'Know Your Agent: identity before money',
    excerpt:
      "KYC asks 'is this person real?' KYA asks 'is this agent real?' Get the order right and payment becomes the easy part.",
    chain: 'Identity',
    accent: '#7342E2',
    date: 'May 12, 2026',
    readingTime: '4 min read',
    seed: 7,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'The order matters',
        body: [
          'You would not wire money to a name you cannot verify. Agents should not either. Identity comes first, payment second.',
          'Most agent payment projects start with the wallet. We start with the passport.',
        ],
      },
      {
        heading: 'A passport, not an account',
        body: [
          'ERC-8004 gives each agent a portable on-chain identity plus a reputation it earns over time. No marketplace owns it, and anyone can check it.',
          'An account can be closed by whoever runs it. A passport belongs to the holder.',
        ],
      },
      {
        heading: 'Reputation you can carry',
        body: [
          'The same score travels across chains, so an agent\'s history is not stuck on the chain it started on.',
          'Trust earned in one place should count everywhere.',
        ],
      },
      {
        heading: 'Then the money is easy',
        body: [
          'Once two agents can verify each other, settling in stablecoins is the simple part. Trust was always the hard part.',
          'Solve identity, and payment stops being scary.',
        ],
      },
    ],
  },
]

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug)
}
