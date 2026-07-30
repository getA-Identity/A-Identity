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
    slug: 'gasless-nanopayments-for-agents',
    title: 'Paying a tenth of a cent: how gasless nanopayments actually work',
    excerpt:
      'A sub-cent payment is uneconomic if the fee to move it costs more than the payment. That is the whole problem with charging agents per call. Here is how batched settlement and an off-chain signature solve it, and what you give up in exchange.',
    chain: 'Payments',
    accent: '#41616B',
    date: 'Jul 31, 2026',
    readingTime: '6 min read',
    seed: 16,
    author: AUTHORS.devrel,
    sections: [
      {
        heading: 'The arithmetic that kills per-call pricing',
        body: [
          'Charging an agent a tenth of a cent for an API call is a lovely idea until you price the transfer. If moving the money costs more than the money, the model does not work, and no amount of protocol design fixes arithmetic.',
          'This is why most agent payment demos quietly charge a cent or more, or batch into a monthly invoice and reintroduce the accounts and API keys the whole thing was supposed to remove.',
          'There are two honest ways out. Make the fee approximately zero, or stop settling every payment individually. The interesting designs do both.',
        ],
      },
      {
        heading: 'Move the signature off-chain, keep the settlement on it',
        body: [
          'The mechanism is an authorization the buyer signs but does not broadcast.',
          'Under EIP-3009, a token holder can sign a message that says "transfer this amount to this address, valid between these times, with this nonce". The signature is data. It costs nothing to produce, and the buyer never touches the chain or holds a gas token.',
          'The seller receives that authorization and hands it to a facilitator, which verifies the signature, credits the seller immediately, and settles on-chain later, batching many authorizations into a single transaction. Thousands of sub-cent payments net into one transfer, and the per-payment fee becomes the batch fee divided across all of them.',
          'That is Circle Gateway\'s batched settlement, and it is what makes a $0.001 call economically real rather than a rounding error you are subsidising.',
        ],
      },
      {
        heading: 'What the buyer experiences',
        body: [
          'An agent calls an endpoint. It gets HTTP 402 with a challenge naming the network, the asset, the amount and the address to pay. It signs an authorization, attaches it, replays the request, and gets the resource.',
          'No gas token. No account. No API key. No prior relationship with the seller. The agent needs a funded balance and a key, and nothing else.',
          'You can see the challenge without paying anything: an unauthenticated GET to our Arc endpoint returns the 402 with the `accepts` block naming Arc testnet and native USDC. Nothing is charged for looking.',
        ],
      },
      {
        heading: 'The chain choice does more work than it looks',
        body: [
          'On most chains the buyer needs the native token for gas even to receive value, which is a real onboarding problem for an autonomous agent: it has to acquire a second asset it has no use for.',
          'On Arc the gas token is USDC. An agent holding dollars can transact with dollars. That removes an entire class of setup, and it is also why Circle Paymaster is not part of our Arc integration: a token paymaster exists to let an account pay gas in USDC where the native token is something else, and here that problem does not exist. We checked rather than assumed, and the published paymaster addresses have no contract behind them on Arc.',
          'Naming the thing you did not integrate, and why, is usually more informative than the list of things you did.',
        ],
      },
      {
        heading: 'What you give up',
        body: [
          'Batched settlement is not free of tradeoffs and the honest version is worth stating.',
          'Finality is split. The seller is credited when the facilitator verifies the signature, but the on-chain transfer happens later, in a batch. For most flows this is fine. For anything that must be irreversible on-chain before you act, it is not, and you should settle individually.',
          'There is a trust step. The facilitator sits between signature and settlement. This is a smaller surface than a custodian, since the authorization is scoped to an amount, a recipient and a time window, but it is not zero and pretending otherwise would be dishonest.',
          'And authorizations expire. A signature carries a validity window, which is a feature, since a leaked authorization cannot be replayed forever. It also means an agent that signs and then stalls will find its authorization dead and have to sign again.',
        ],
      },
      {
        heading: 'When to use which rail',
        body: [
          'Use per-call on-chain settlement when payments are large enough that the fee is noise, when you need on-chain finality before acting, or when you want each payment to be independently verifiable by a third party without asking a facilitator anything.',
          'Use batched nanopayments when payments are genuinely small, when volume is high, and when the buyer should not have to hold a gas token to participate.',
          'We run both. The trust oracle settles per call on X Layer, which is why every one of those 120 settlements has its own transaction hash you can check. The Arc rail uses Gateway batching. Same protocol, different economics, chosen per use rather than as a religion.',
        ],
      },
      {
        heading: 'Trying it',
        body: [
          'Send an unauthenticated GET to our Arc nanopayment endpoint and read the challenge. It costs nothing, needs no key, and shows you the exact shape of an x402 v2 payment requirement on a chain where gas is already USDC.',
          'If you want the paid tools instead, `trust_preview` is free and rate limited, and the rest are priced from $0.001 to $0.01 with the full table published.',
        ],
      },
    ],
    tr: {
      title: 'Kuruşun onda birini ödemek: gassız nanopayment nasıl çalışır',
      excerpt:
        'Kuruş altı bir ödeme, onu taşımanın ücreti ödemeden pahalıysa ekonomik değildir. Ajanlardan çağrı başına ücret almanın bütün problemi budur. Toplu settlement ve zincir dışı bir imzanın bunu nasıl çözdüğü ve karşılığında neyden vazgeçtiğiniz.',
      chain: 'Ödemeler',
      readingTime: '6 dakika',
      sections: [
        {
          heading: 'Çağrı başına fiyatlandırmayı öldüren aritmetik',
          body: [
            'Bir ajandan bir API çağrısı için kuruşun onda birini almak, transferi fiyatlandırana kadar hoş bir fikirdir. Parayı taşımak paradan pahalıysa model çalışmaz ve hiçbir protokol tasarımı aritmetiği düzeltmez.',
            'Çoğu ajan ödeme demosunun sessizce bir kuruş veya daha fazlasını almasının ya da aylık faturaya toplayıp baştan kaldırmak istediği hesapları ve API anahtarlarını geri getirmesinin sebebi budur.',
            'Buradan çıkmanın dürüst iki yolu var. Ücreti yaklaşık sıfır yapmak ya da her ödemeyi tek tek gerçekleştirmeyi bırakmak. İlginç tasarımlar ikisini birden yapıyor.',
          ],
        },
        {
          heading: 'İmzayı zincir dışına alın, settlement zincirde kalsın',
          body: [
            'Mekanizma, alıcının imzaladığı ama yayınlamadığı bir yetkilendirmedir.',
            'EIP-3009 kapsamında bir token sahibi, "bu tutarı bu adrese aktar, şu zamanlar arasında geçerli, şu nonce ile" diyen bir mesaj imzalayabilir. İmza veridir. Üretmenin maliyeti yoktur ve alıcı zincire hiç dokunmaz, gas token\'ı tutmaz.',
            'Satıcı bu yetkilendirmeyi alır ve bir aracıya verir; aracı imzayı doğrular, satıcıyı anında alacaklandırır ve zincir üstü settlement\'ı sonra, birçok yetkilendirmeyi tek bir işlemde toplayarak yapar. Binlerce kuruş altı ödeme tek bir transferde netleşir ve ödeme başına ücret, toplu işlem ücretinin hepsine bölünmesi haline gelir.',
            'Circle Gateway\'in toplu settlement\'ı budur ve 0,001 dolarlık bir çağrıyı, sübvanse ettiğiniz bir yuvarlama hatası olmaktan çıkarıp ekonomik olarak gerçek kılan şeydir.',
          ],
        },
        {
          heading: 'Alıcının deneyimi',
          body: [
            'Bir ajan bir ucu çağırır. Ağı, varlığı, tutarı ve ödenecek adresi belirten bir meydan okumayla HTTP 402 alır. Bir yetkilendirme imzalar, ekler, isteği tekrarlar ve kaynağı alır.',
            'Gas token yok. Hesap yok. API anahtarı yok. Satıcıyla önceden kurulmuş bir ilişki yok. Ajanın fonlanmış bir bakiyeye ve bir anahtara ihtiyacı var, başka hiçbir şeye değil.',
            'Meydan okumayı hiçbir şey ödemeden görebilirsiniz: Arc ucumuza kimlik doğrulamasız bir GET, Arc testnet ve yerel USDC\'yi belirten `accepts` bloğuyla 402 döner. Bakmanın ücreti yok.',
          ],
        },
        {
          heading: 'Zincir seçimi göründüğünden fazla iş yapıyor',
          body: [
            'Çoğu zincirde alıcının, değer almak için bile gas amacıyla yerel token\'a ihtiyacı vardır ve bu otonom bir ajan için gerçek bir başlangıç problemidir: hiçbir işine yaramayan ikinci bir varlık edinmesi gerekir.',
            'Arc\'ta gas token\'ı USDC\'dir. Dolar tutan bir ajan dolarla işlem yapabilir. Bu, bütün bir kurulum sınıfını ortadan kaldırıyor ve Circle Paymaster\'ın Arc entegrasyonumuzun parçası olmamasının sebebi de bu: token paymaster, yerel token başka bir şeyken bir hesabın gas\'ı USDC ile ödemesini sağlamak için vardır ve burada o problem yoktur. Varsaymak yerine kontrol ettik; yayınlanan paymaster adreslerinin Arc üzerinde arkasında sözleşme yok.',
            'Entegre etmediğiniz şeyi ve nedenini söylemek, genellikle ettiklerinizin listesinden daha bilgilendiricidir.',
          ],
        },
        {
          heading: 'Neyden vazgeçiyorsunuz',
          body: [
            'Toplu settlement takaslardan muaf değil ve dürüst versiyonu söylemeye değer.',
            'Kesinlik ikiye ayrılıyor. Satıcı, aracı imzayı doğruladığında alacaklandırılır, ama zincir üstü transfer sonra, toplu halde gerçekleşir. Çoğu akış için bu sorun değil. Harekete geçmeden önce zincir üstünde geri alınamaz olması gereken bir şey içinse sorundur ve tek tek gerçekleştirmelisiniz.',
            'Bir güven adımı var. Aracı, imza ile settlement arasında duruyor. Bu bir saklayıcıdan daha küçük bir yüzey, çünkü yetkilendirme bir tutara, bir alıcıya ve bir zaman penceresine sınırlı, ama sıfır değil ve öyleymiş gibi davranmak dürüst olmaz.',
            'Ve yetkilendirmeler süresi dolar. Bir imza geçerlilik penceresi taşır ki bu bir özelliktir, çünkü sızmış bir yetkilendirme sonsuza kadar tekrar kullanılamaz. Aynı zamanda imzalayıp sonra bekleyen bir ajanın yetkilendirmesinin ölmüş olacağı ve yeniden imzalaması gerekeceği anlamına gelir.',
          ],
        },
        {
          heading: 'Hangi rayı ne zaman kullanmalı',
          body: [
            'Ödemeler ücretin gürültü kaldığı kadar büyükse, harekete geçmeden önce zincir üstü kesinliğe ihtiyacınız varsa ya da her ödemenin bir aracıya hiçbir şey sormadan üçüncü bir tarafça bağımsız doğrulanabilmesini istiyorsanız çağrı başına zincir üstü settlement kullanın.',
            'Ödemeler gerçekten küçükse, hacim yüksekse ve alıcının katılmak için gas token tutmak zorunda kalmaması gerekiyorsa toplu nanopayment kullanın.',
            'Biz ikisini de işletiyoruz. Güven oracle\'ı X Layer üzerinde çağrı başına gerçekleştiriyor, o 120 settlement\'ın her birinin kontrol edebileceğiniz kendi işlem özetinin olmasının sebebi bu. Arc rayı Gateway toplu işlemini kullanıyor. Aynı protokol, farklı ekonomi, bir inanç olarak değil kullanıma göre seçilmiş.',
          ],
        },
        {
          heading: 'Denemek',
          body: [
            'Arc nanopayment ucumuza kimlik doğrulamasız bir GET gönderin ve meydan okumayı okuyun. Ücreti yok, anahtar istemiyor ve gas\'ın zaten USDC olduğu bir zincirde bir x402 v2 ödeme gereksiniminin tam şeklini gösteriyor.',
            'Bunun yerine ücretli araçları istiyorsanız, `trust_preview` ücretsiz ve hız sınırlı; diğerleri 0,001 ile 0,01 dolar arasında fiyatlanıyor ve tam tablo yayında.',
          ],
        },
      ],
    },
  },
  {
    slug: 'agents-trading-with-themselves',
    title: 'When an agent trades with itself: detecting same-operator self-dealing',
    excerpt:
      'The cheapest way to manufacture a trustworthy agent is to build two of them and have them pay each other. Both look clean in isolation. This is how the pattern works, why one-sided checks cannot see it, and what actually gives it away.',
    chain: 'Risk',
    accent: '#7342E2',
    date: 'Jul 31, 2026',
    readingTime: '6 min read',
    seed: 15,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'Reputation you can buy from yourself',
        body: [
          'Any system that scores agents on settled payments has an obvious exploit, and it is worth stating plainly because we build one of those systems.',
          'An operator registers two agents. Agent A pays agent B, repeatedly, in small amounts. Every payment is a genuine on-chain transfer with a real hash. Neither agent is doing anything a protocol would reject. After a few dozen rounds both have a settlement history, both score well, and the operator has spent only gas and the float between its own wallets.',
          'Now agent B goes and sells to a stranger, carrying a reputation it manufactured. That is the attack, and it costs almost nothing.',
        ],
      },
      {
        heading: 'Why checking one side cannot work',
        body: [
          'Look at agent B on its own and everything is fine. Registered, KYA passed, dozens of completed settlements, no revocations, reasonable tenure. Every individual fact is true.',
          'Look at agent A on its own and the same applies.',
          'The fraud does not live in either agent. It lives in the relationship between them, and a check that takes one agent id as input cannot see a relationship by construction. This is not a matter of the model being insufficiently clever; the information is not in the input.',
          'That is why a two-sided check is a different product rather than a better version of the same one. It takes both parties and asks whether they are independent.',
        ],
      },
      {
        heading: 'What actually gives it away',
        body: [
          'Four signals, in rough order of how hard they are to fake.',
          'The first is funding lineage. Two agents whose wallets were funded from the same source, especially in the same transaction or within a few blocks, are related until proven otherwise. An operator can launder this with intermediate hops, but each hop costs effort and leaves more graph.',
          'The second is the shape of the payment graph. Honest commerce is lopsided and open: an agent pays many counterparties, receives from a different set, and value flows through it. Manufactured history is closed: the same pair, back and forth, value circulating rather than arriving. Measure how much of an agent\'s volume comes from its top counterparty. A number near one is not a customer relationship, it is a loop.',
          'The third is timing regularity. Humans and real workloads are bursty. Payments spaced with machine regularity, at the same interval, in the same amount, are a script rather than a business.',
          'The fourth is registration and deployment fingerprints: agents registered minutes apart, from the same address, with endpoints on the same host or the same certificate. Individually weak, jointly strong.',
        ],
      },
      {
        heading: 'The problem with catching it',
        body: [
          'Every one of those signals has a legitimate version, and that is the hard part.',
          'Two agents funded from the same treasury might be two products of the same honest company, which is normal and not fraud. A high concentration with one counterparty might be an agent with one large genuine customer. Regular timing might be a genuine scheduled workload.',
          'So this cannot be a boolean. Treat it as evidence that raises or lowers confidence, weight it against the amount at stake, and report it as a reason rather than a verdict. "These two parties appear to share funding and 94 percent of this agent\'s volume is with the other" is something a human can adjudicate. "SELF_DEALING_DETECTED" is a support ticket.',
          'The right response to a strong signal is usually WARN, not DENY. You are saying the relationship looks closed, not that a crime occurred.',
        ],
      },
      {
        heading: 'What this means if you are honest and look suspicious',
        body: [
          'If you run several agents from one treasury, you will trip some of these signals, and there is a reasonable way to handle that.',
          'Fund agents from distinct wallets where you can. Do not have your own agents transact with each other purely to generate history, because that history is worth nothing and the pattern is what gets flagged. Build settlement history with real third parties, even a small number, because concentration is measured against your whole graph and a handful of genuine external counterparties changes the shape.',
          'The general principle: a reputation built from transactions with strangers is the only kind that means anything, which is inconvenient early and is also the entire point.',
        ],
      },
      {
        heading: 'Where the check belongs in your flow',
        body: [
          'Run it before you commit value, alongside the counterparty risk check rather than instead of it. They answer different questions: one asks whether this party is sound, the other asks whether this pair is independent.',
          'It matters most at the moment an agent you have never dealt with presents a strong reputation. That is exactly the situation the attack is designed to produce, so a good history from an unknown counterparty should raise the bar for the two-sided check rather than lower it.',
          'Our own data has something uncomfortable to say here. Of the 120 settlements our trust oracle has taken, the two-sided check accounts for 6, about 5 percent. It is by a wide margin the least-bought thing we sell. Either it is under-explained, which is on us, or the ecosystem is still small enough that nobody has been burned yet. We cannot tell which from the data, and only one of those fixes itself.',
        ],
      },
      {
        heading: 'Trying it',
        body: [
          '`counterparty_check` takes both agent ids and the intended amount, and returns a verdict with the reasons that produced it. It is the only call we offer that examines a relationship rather than a party.',
          'If you are building your own version of this rather than using ours, that is a good outcome too. The pattern is cheap to run and currently under-defended across the whole ecosystem, and the first operators to exploit it at scale will do it against whoever is not looking.',
        ],
      },
    ],
    tr: {
      title: 'Bir ajan kendisiyle ticaret yapınca: aynı operatörlü kendi kendine ticareti tespit etmek',
      excerpt:
        'Güvenilir bir ajan imal etmenin en ucuz yolu, iki tane yapıp birbirlerine ödeme yaptırmaktır. İkisi de tek başına bakıldığında temiz görünür. Bu kalıbın nasıl işlediği, tek taraflı kontrollerin bunu neden göremediği ve gerçekte neyin ele verdiği.',
      chain: 'Risk',
      readingTime: '6 dakika',
      sections: [
        {
          heading: 'Kendinizden satın alabileceğiniz itibar',
          body: [
            'Ajanları gerçekleşmiş ödemelere göre puanlayan her sistemin bariz bir açığı vardır ve bunu açıkça söylemeye değer, çünkü biz de o sistemlerden birini kuruyoruz.',
            'Bir operatör iki ajan kaydeder. A ajanı B ajanına, tekrar tekrar, küçük tutarlarda ödeme yapar. Her ödeme, gerçek bir özeti olan hakiki bir zincir üstü transferdir. Hiçbir ajan, bir protokolün reddedeceği bir şey yapmıyordur. Birkaç düzine turdan sonra ikisinin de settlement geçmişi olur, ikisi de iyi puan alır ve operatör yalnızca gas ile kendi cüzdanları arasındaki parayı harcamıştır.',
            'Şimdi B ajanı gidip bir yabancıya satış yapar ve imal ettiği itibarı yanında taşır. Saldırı budur ve neredeyse hiçbir maliyeti yoktur.',
          ],
        },
        {
          heading: 'Tek tarafa bakmak neden işe yaramaz',
          body: [
            'B ajanına tek başına bakın, her şey yolundadır. Kayıtlı, KYA geçmiş, onlarca tamamlanmış settlement, iptal yok, makul bir kıdem. Her bir bilgi tek tek doğrudur.',
            'A ajanına tek başına bakın, aynısı geçerlidir.',
            'Dolandırıcılık ajanların hiçbirinde yaşamıyor. İkisi arasındaki ilişkide yaşıyor ve girdi olarak tek bir ajan kimliği alan bir kontrol, yapısı gereği bir ilişkiyi göremez. Bu, modelin yeterince akıllı olmamasıyla ilgili değil; bilgi girdide yok.',
            'Bu yüzden iki taraflı kontrol, aynı ürünün daha iyi bir sürümü değil, farklı bir üründür. İki tarafı da alır ve bağımsız olup olmadıklarını sorar.',
          ],
        },
        {
          heading: 'Gerçekte neyin ele verdiği',
          body: [
            'Dört sinyal, taklit edilmelerinin zorluğuna göre kabaca sıralanmış halde.',
            'Birincisi fonlama soyağacı. Cüzdanları aynı kaynaktan, özellikle aynı işlemde veya birkaç blok içinde fonlanmış iki ajan, aksi kanıtlanana kadar ilişkilidir. Bir operatör bunu ara sıçramalarla aklayabilir, ama her sıçrama emek ister ve arkasında daha fazla grafik bırakır.',
            'İkincisi ödeme grafiğinin şekli. Dürüst ticaret dengesiz ve açıktır: bir ajan birçok karşı tarafa öder, farklı bir kümeden tahsil eder ve değer içinden akar. İmal edilmiş geçmiş kapalıdır: aynı çift, ileri geri, değer varmak yerine dolaşır. Bir ajanın hacminin ne kadarının en büyük karşı tarafından geldiğini ölçün. Bire yakın bir sayı müşteri ilişkisi değil, döngüdür.',
            'Üçüncüsü zamanlama düzenliliği. İnsanlar ve gerçek iş yükleri kesiklidir. Makine düzenliliğinde aralıklarla, aynı sıklıkta, aynı tutarda yapılan ödemeler bir iş değil, bir betiktir.',
            'Dördüncüsü kayıt ve dağıtım parmak izleri: dakikalar arayla, aynı adresten kaydedilmiş, uçları aynı sunucuda veya aynı sertifikada olan ajanlar. Tek tek zayıf, birlikte güçlü.',
          ],
        },
        {
          heading: 'Yakalamanın zorluğu',
          body: [
            'Bu sinyallerin her birinin meşru bir versiyonu var ve zor olan kısım bu.',
            'Aynı hazineden fonlanan iki ajan, aynı dürüst şirketin iki ürünü olabilir ki bu normaldir ve dolandırıcılık değildir. Tek bir karşı tarafla yüksek yoğunlaşma, tek büyük gerçek müşterisi olan bir ajan olabilir. Düzenli zamanlama, gerçek bir zamanlanmış iş yükü olabilir.',
            'Dolayısıyla bu bir evet/hayır olamaz. Güveni artıran veya azaltan bir kanıt olarak ele alın, riske atılan tutara karşı ağırlıklandırın ve bir karar olarak değil bir gerekçe olarak raporlayın. "Bu iki taraf fonlamayı paylaşıyor görünüyor ve bu ajanın hacminin yüzde 94\'ü diğeriyle" cümlesi bir insanın hükme bağlayabileceği bir şeydir. "SELF_DEALING_DETECTED" ise bir destek talebidir.',
            'Güçlü bir sinyale doğru cevap genellikle DENY değil WARN\'dır. İlişkinin kapalı göründüğünü söylüyorsunuz, bir suç işlendiğini değil.',
          ],
        },
        {
          heading: 'Dürüstseniz ama şüpheli görünüyorsanız',
          body: [
            'Tek bir hazineden birkaç ajan işletiyorsanız bu sinyallerin bir kısmına takılacaksınız ve bununla başa çıkmanın makul bir yolu var.',
            'Yapabildiğiniz yerde ajanları ayrı cüzdanlardan fonlayın. Sırf geçmiş üretmek için kendi ajanlarınıza birbiriyle işlem yaptırmayın, çünkü o geçmiş hiçbir şey ifade etmiyor ve işaretlenen şey zaten o kalıp. Settlement geçmişini gerçek üçüncü taraflarla kurun, sayıları az olsa bile, çünkü yoğunlaşma tüm grafiğinize karşı ölçülür ve bir avuç hakiki dış karşı taraf şekli değiştirir.',
            'Genel ilke şu: yabancılarla yapılan işlemlerden inşa edilmiş bir itibar, anlam ifade eden tek türdür; bu başlangıçta zahmetlidir ve zaten meselenin tamamı budur.',
          ],
        },
        {
          heading: 'Bu kontrolün akıştaki yeri',
          body: [
            'Değeri bağlamadan önce, karşı taraf risk kontrolünün yerine değil onunla birlikte çalıştırın. Farklı sorular cevaplıyorlar: biri bu tarafın sağlam olup olmadığını, diğeri bu çiftin bağımsız olup olmadığını soruyor.',
            'En çok, hiç iş yapmadığınız bir ajanın güçlü bir itibarla karşınıza çıktığı anda önemlidir. Saldırının üretmek için tasarlandığı durum tam olarak budur, dolayısıyla bilinmeyen bir karşı taraftan gelen iyi bir geçmiş, iki taraflı kontrol çıtasını düşürmek yerine yükseltmelidir.',
            'Kendi verimizin burada rahatsız edici bir şey söylediği var. Güven oracle\'ımızın aldığı 120 settlement\'ın 6\'sı, yani yaklaşık yüzde 5\'i iki taraflı kontrol. Sattığımız en az satın alınan şey, hem de açık ara. Ya yeterince anlatılmamış ki bu bizim sorunumuz, ya da ekosistem henüz kimsenin canının yanmadığı kadar küçük. Veriden hangisi olduğunu ayırt edemiyoruz ve bunlardan yalnızca biri kendi kendine düzeliyor.',
          ],
        },
        {
          heading: 'Denemek',
          body: [
            '`counterparty_check` iki ajan kimliğini ve amaçlanan tutarı alır, kararı onu üreten gerekçelerle birlikte döndürür. Bir tarafı değil bir ilişkiyi inceleyen tek çağrımız.',
            'Bunun kendi versiyonunuzu bizimkini kullanmak yerine kuruyorsanız, o da iyi bir sonuç. Kalıbı çalıştırmak ucuz ve şu anda tüm ekosistem genelinde yetersiz savunuluyor; bunu ölçekte ilk sömürecek operatörler, bakmayan kim varsa ona karşı yapacak.',
          ],
        },
      ],
    },
  },
  {
    slug: 'erc-8004-and-x402-together',
    title: 'ERC-8004 and x402 together: who you are, and what you owe',
    excerpt:
      'Plenty has been written about each of these standards on its own. Almost nothing describes what happens when you use both, which is the configuration any real agent-to-agent transaction needs. They solve adjacent problems and the seam between them is where the interesting failures live.',
    chain: 'Standards',
    accent: '#6B5A2E',
    date: 'Jul 31, 2026',
    readingTime: '7 min read',
    seed: 14,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'Two standards, one transaction',
        body: [
          'ERC-8004 gives an agent an on-chain identity: a registry entry with a token id, an owner, endpoints, and a place to attach reputation and validation records. It answers who.',
          'x402 gives a server a way to charge for a request: an unpaid call returns HTTP 402 with machine-readable payment requirements, the client settles, and the request is replayed. It answers how much and how.',
          'Neither answers the other. x402 will happily take money from an agent nobody has ever heard of, and ERC-8004 will happily describe an agent that never pays for anything. A real transaction between two agents needs both, and the interesting part is what sits between them.',
        ],
      },
      {
        heading: 'The order matters, and most examples get it backwards',
        body: [
          'The natural way to write the integration is: call the endpoint, get a 402, pay it, get the resource. Identity, if it appears at all, gets checked afterwards when you decide whether to trust what came back.',
          'That is the wrong order for anything that costs real money. By the time you have paid, the only question left is whether you were right to, and a settled stablecoin transfer has no undo.',
          'The correct sequence is: resolve the counterparty first, decide whether to transact, and only then satisfy the 402. Identity is a precondition of payment, not a post-hoc audit of it. This sounds obvious written down and is routinely the other way round in practice, because the 402 is what the code hits first and it is easy to let control flow dictate order of reasoning.',
        ],
      },
      {
        heading: 'What the 402 challenge tells you about the payee',
        body: [
          'An x402 challenge names a `payTo` address, a network, an asset and an amount. That address is the seam.',
          'The question nobody asks is whether the address in the challenge belongs to the agent you think you are buying from. Nothing in x402 asserts that, and nothing in ERC-8004 automatically binds a registry entry to the address a server happens to put in a 402 response.',
          'So the check that matters is: does the `payTo` in this challenge match the address the counterparty proved control of on-chain? If a server can be persuaded to serve a 402 with someone else\'s address in it, or if an agent\'s registry entry lists an address it never proved it holds, the payment goes to the wrong place while every individual component behaves exactly as specified.',
          'This is why KYA, the attestation that an agent controls the wallet it claims, is not a nicety. It is the thing that makes the seam load-bearing.',
        ],
      },
      {
        heading: 'The identifier problem',
        body: [
          'ERC-8004 identities can be referenced several ways: a token id like `#849980`, a CAIP identifier like `eip155:5042002:8004/849980`, or the owner\'s `0x` address. All three resolve to the same agent.',
          'That flexibility is convenient and it is also a place bugs hide. Code that compares identifiers as strings will decide that `#849980` and its CAIP form are different agents, and code that treats the owner address as the identity will merge two agents that share an owner.',
          'Normalise to one canonical form at the boundary of your system and compare only that. An agent identity is not a string, and treating it like one works right up until an operator registers two agents from the same wallet.',
        ],
      },
      {
        heading: 'Chains do not have to agree',
        body: [
          'Here is the part that catches people building their first cross-chain flow: the chain where identity lives and the chain where money moves are not required to be the same chain, and frequently are not.',
          'An agent can hold an ERC-8004 registration on one network and settle x402 payments on another. Our own trust oracle does exactly this: identity reads against Circle Arc, settlement on X Layer.',
          'Nothing is wrong with that, but it means your verification and your payment are two different chain reads against two different sources of truth, and they can disagree. An identity revoked on one chain does not automatically stop a payment settling on another. If your risk logic assumes both facts came from the same place, it will be confidently wrong at exactly the wrong moment.',
        ],
      },
      {
        heading: 'Reputation has to be computed over payments, not claims',
        body: [
          'ERC-8004 has a reputation registry, which standardises how feedback gets recorded. It does not make that feedback true. Anyone can attest anything about anyone, and a registry entry full of glowing attestations from addresses nobody has heard of is worth precisely nothing.',
          'The useful signal is on the x402 side: settlements. A payment is a claim somebody backed with money, which is a materially different kind of evidence from a rating.',
          'So the practical build is to compute reputation from settlement history rather than from attestations, and use the reputation registry as a place to publish the result rather than as an input. That is the direction the two standards compose in: x402 produces the evidence, ERC-8004 gives it somewhere to live.',
        ],
      },
      {
        heading: 'What a complete flow looks like',
        body: [
          'Resolve the counterparty from its identifier, normalised. Confirm it holds a registration and that KYA proves control of the wallet in question. Compute or fetch reputation over settled payments, not attestations. Size the risk to the amount you are about to send, not in the abstract. Check the payment against your own spending limits, which is a separate question from whether the counterparty is sound. Only then satisfy the 402, confirming that `payTo` matches the address you verified.',
          'Six steps, of which x402 covers the last one and ERC-8004 covers parts of the first two. Everything between is the layer neither standard specifies, which is precisely why it is worth being deliberate about.',
        ],
      },
      {
        heading: 'Trying it',
        body: [
          'A-Identity implements the middle of that flow as pay-per-call endpoints, and is itself an ERC-8004 agent paid over x402, so the whole loop is dogfooded rather than described.',
          '`trust_preview` is free and needs no key, so you can see the shape of a verification result before wiring anything. The scoring method is published and the settlements behind it are listed with their transaction hashes.',
        ],
      },
    ],
    tr: {
      title: 'ERC-8004 ve x402 birlikte: kim olduğunuz ve ne borçlu olduğunuz',
      excerpt:
        'Bu standartların her biri hakkında ayrı ayrı çok şey yazıldı. İkisini birlikte kullanınca ne olduğunu anlatan neredeyse hiçbir şey yok, oysa gerçek bir ajan-ajana işlemin ihtiyaç duyduğu yapılandırma tam olarak bu. Komşu problemleri çözüyorlar ve aralarındaki dikiş yeri, ilginç hataların yaşadığı yer.',
      chain: 'Standartlar',
      readingTime: '7 dakika',
      sections: [
        {
          heading: 'İki standart, tek işlem',
          body: [
            'ERC-8004 bir ajana zincir üstü kimlik verir: token kimliği, sahip, uçlar ve itibar ile doğrulama kayıtlarının iliştirileceği bir yer içeren bir kayıt girdisi. "Kim" sorusunu cevaplar.',
            'x402 bir sunucuya bir istek için ücret alma yolu verir: ödenmemiş bir çağrı, makine tarafından okunabilir ödeme gereksinimleriyle HTTP 402 döner, istemci öder ve istek tekrarlanır. "Ne kadar" ve "nasıl" sorularını cevaplar.',
            'Hiçbiri diğerini cevaplamaz. x402, kimsenin duymadığı bir ajandan seve seve para alır; ERC-8004 ise hiçbir şeye ödeme yapmayan bir ajanı seve seve tarif eder. İki ajan arasındaki gerçek bir işlem ikisine de ihtiyaç duyar ve ilginç olan kısım, aralarında duran şeydir.',
          ],
        },
        {
          heading: 'Sıra önemli ve çoğu örnek tersten yapıyor',
          body: [
            'Entegrasyonu yazmanın doğal yolu şudur: ucu çağır, 402 al, öde, kaynağı al. Kimlik, eğer hiç devreye giriyorsa, gelen şeye güvenip güvenmeyeceğinize karar verirken sonradan kontrol edilir.',
            'Gerçek para söz konusu olan hiçbir şey için bu doğru sıra değildir. Ödediğiniz ana kadar geriye kalan tek soru haklı olup olmadığınızdır ve gerçekleşmiş bir stablecoin transferinin geri alması yoktur.',
            'Doğru sıra şudur: önce karşı tarafı çözümleyin, işlem yapıp yapmayacağınıza karar verin ve ancak ondan sonra 402\'yi karşılayın. Kimlik, ödemenin bir ön koşuludur, sonradan yapılan denetimi değil. Yazınca bariz duruyor ama pratikte düzenli olarak tersi yapılıyor, çünkü kodun ilk çarptığı şey 402 ve kontrol akışının düşünme sırasını belirlemesine izin vermek kolay.',
          ],
        },
        {
          heading: '402 meydan okuması size alıcı hakkında ne söyler',
          body: [
            'Bir x402 meydan okuması bir `payTo` adresi, bir ağ, bir varlık ve bir tutar belirtir. O adres, dikiş yeridir.',
            'Kimsenin sormadığı soru şudur: bu meydan okumadaki adres, satın aldığınızı sandığınız ajana mı ait? x402 içinde bunu iddia eden hiçbir şey yok ve ERC-8004 içinde bir kayıt girdisini, bir sunucunun 402 cevabına koyduğu adrese otomatik olarak bağlayan hiçbir şey yok.',
            'Dolayısıyla önemli olan kontrol şudur: bu meydan okumadaki `payTo`, karşı tarafın zincir üstünde kontrolünü kanıtladığı adresle eşleşiyor mu? Bir sunucu, içinde başkasının adresi olan bir 402 sunmaya ikna edilebiliyorsa ya da bir ajanın kayıt girdisi hiç sahipliğini kanıtlamadığı bir adresi listeliyorsa, her bileşen tam olarak tarif edildiği gibi davranırken ödeme yanlış yere gider.',
            'KYA\'nın, yani bir ajanın iddia ettiği cüzdanı kontrol ettiğine dair belgenin, bir incelik olmamasının sebebi budur. Dikiş yerini taşıyıcı hale getiren şey odur.',
          ],
        },
        {
          heading: 'Tanımlayıcı problemi',
          body: [
            'ERC-8004 kimliklerine birkaç şekilde atıf yapılabilir: `#849980` gibi bir token kimliği, `eip155:5042002:8004/849980` gibi bir CAIP tanımlayıcısı ya da sahibin `0x` adresi. Üçü de aynı ajanı çözümler.',
            'Bu esneklik pratiktir ve aynı zamanda hataların saklandığı bir yerdir. Tanımlayıcıları metin olarak karşılaştıran kod, `#849980` ile onun CAIP biçiminin farklı ajanlar olduğuna karar verir; sahip adresini kimlik sayan kod ise aynı sahibi paylaşan iki ajanı birleştirir.',
            'Sisteminizin sınırında tek bir kanonik biçime normalleştirin ve yalnızca onu karşılaştırın. Bir ajan kimliği bir metin değildir ve öyleymiş gibi davranmak, bir operatör aynı cüzdandan iki ajan kaydedene kadar sorunsuz çalışır.',
          ],
        },
        {
          heading: 'Zincirlerin aynı olması gerekmiyor',
          body: [
            'İlk zincirler arası akışını kuran insanları yakalayan kısım şu: kimliğin yaşadığı zincir ile paranın hareket ettiği zincirin aynı olması gerekmez ve sıklıkla aynı değildir.',
            'Bir ajan bir ağda ERC-8004 kaydı tutup x402 ödemelerini başka bir ağda gerçekleştirebilir. Bizim güven oracle\'ımız tam olarak bunu yapıyor: kimlik okumaları Circle Arc üzerinde, settlement X Layer üzerinde.',
            'Bunda yanlış bir şey yok, ama şu anlama geliyor: doğrulamanız ve ödemeniz, iki farklı doğruluk kaynağına karşı yapılan iki farklı zincir okumasıdır ve birbirleriyle çelişebilirler. Bir zincirde iptal edilmiş bir kimlik, başka bir zincirde gerçekleşen ödemeyi otomatik olarak durdurmaz. Risk mantığınız iki bilginin de aynı yerden geldiğini varsayıyorsa, tam da en yanlış anda kendinden emin biçimde yanılacaktır.',
          ],
        },
        {
          heading: 'İtibar iddialardan değil, ödemelerden hesaplanmalı',
          body: [
            'ERC-8004\'ün bir itibar kaydı var ve bu, geri bildirimin nasıl kaydedileceğini standartlaştırıyor. Ama o geri bildirimi doğru yapmıyor. Herkes herkes hakkında her şeyi beyan edebilir ve kimsenin duymadığı adreslerden gelen övgülerle dolu bir kayıt girdisi tam olarak hiçbir şey ifade etmez.',
            'İşe yarayan sinyal x402 tarafındadır: settlement\'lar. Bir ödeme, birinin parasıyla arkasında durduğu bir iddiadır ve bu, bir puanlamadan maddi olarak farklı türde bir kanıttır.',
            'Dolayısıyla pratik kurulum, itibarı beyanlardan değil settlement geçmişinden hesaplamak ve itibar kaydını girdi olarak değil, sonucu yayınlanacak bir yer olarak kullanmaktır. İki standardın birleştiği yön budur: x402 kanıtı üretir, ERC-8004 ona yaşayacak bir yer verir.',
          ],
        },
        {
          heading: 'Tam bir akış nasıl görünür',
          body: [
            'Karşı tarafı tanımlayıcısından, normalleştirilmiş biçimde çözümleyin. Bir kaydı olduğunu ve KYA\'nın söz konusu cüzdanın kontrolünü kanıtladığını doğrulayın. İtibarı beyanlardan değil, gerçekleşmiş ödemelerden hesaplayın veya çekin. Riski soyut olarak değil, göndermek üzere olduğunuz tutara göre boyutlandırın. Ödemeyi kendi harcama limitlerinize karşı kontrol edin, ki bu karşı tarafın sağlam olup olmadığından ayrı bir sorudur. Ancak ondan sonra, `payTo`\'nun doğruladığınız adresle eşleştiğini teyit ederek 402\'yi karşılayın.',
            'Altı adım; bunların sonuncusunu x402, ilk ikisinin bir kısmını ERC-8004 kapsıyor. Aradaki her şey, hiçbir standardın belirlemediği katman, ki bu konuda bilinçli olmaya değmesinin sebebi tam olarak bu.',
          ],
        },
        {
          heading: 'Denemek',
          body: [
            'A-Identity bu akışın ortasını çağrı başına ödemeli uçlar olarak uyguluyor ve kendisi de x402 üzerinden ödeme alan bir ERC-8004 ajanı, dolayısıyla döngünün tamamı anlatılmakla kalmıyor, bizzat kullanılıyor.',
            '`trust_preview` ücretsiz ve anahtar istemiyor, böylece hiçbir şey bağlamadan bir doğrulama sonucunun nasıl göründüğünü görebilirsiniz. Skorlama yöntemi yayında ve arkasındaki settlement\'lar işlem özetleriyle listeleniyor.',
          ],
        },
      ],
    },
  },
  {
    slug: 'what-120-real-agent-payments-look-like',
    title: 'What 120 real agent-to-agent payments actually look like',
    excerpt:
      'Almost everything written about agentic payments is a forecast. This is not. Here is the shape of 120 settlements our trust oracle actually took on mainnet, what the distribution says about how agents buy, and the numbers that surprised us.',
    chain: 'Data',
    accent: '#2B4A7E',
    date: 'Jul 31, 2026',
    readingTime: '6 min read',
    seed: 13,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'Why this is worth writing down',
        body: [
          'The agentic payments literature is almost entirely forward looking. Market sizing, protocol explainers, diagrams of how it will work. Very little of it describes transactions that happened.',
          'We run a trust oracle that agents pay per call to check each other. It has taken 120 settlements on X Layer mainnet, in real USD₮0, totalling $0.528. Every one is listed with its transaction hash and anyone can verify the set independently.',
          'It is a small dataset and we are not going to pretend otherwise. But it is a real one, and there is more to learn from 120 payments that happened than from a projection of a billion that have not.',
        ],
      },
      {
        heading: 'The shape of demand',
        body: [
          'Across 120 calls, five of the seven tools were bought at all. The distribution:',
          'verify_agent, 32 calls, 27 percent. reputation_score, 29 calls, 24 percent. risk_check, 28 calls, 23 percent. agent_passport, 25 calls, 21 percent. counterparty_check, 6 calls, 5 percent.',
          'The first thing to notice is how flat the top four are. We expected the cheapest call to dominate, since verify_agent costs a tenth of what agent_passport does. It did not. The four sit within six points of each other, which suggests buyers were choosing by what they needed rather than by price.',
        ],
      },
      {
        heading: 'The surprise: price barely steered anything',
        body: [
          'Our prices span an order of magnitude, from $0.001 to $0.01. If agents were cost-sensitive at this scale, the mix would be heavily weighted to the cheap end. It is not: the $0.01 passport took 21 percent of calls, nearly matching the $0.001 identity check at 27 percent.',
          'The average settlement was $0.0044, which sits near the middle of the range rather than near the floor.',
          'The honest reading is that at sub-cent prices, cost is not a decision variable for an agent. A tenth of a cent and one cent are both effectively free relative to the value of the decision being made, so the agent picks the call that answers its question. This has an uncomfortable implication for anyone planning to compete on price in this market: below some threshold, price stops being a lever at all.',
        ],
      },
      {
        heading: 'The tool nobody bought',
        body: [
          'counterparty_check took 6 calls, 5 percent of the total. It is the only tool that examines both sides of a proposed deal, and it is the only one that can detect same-operator self-dealing, where one entity runs both agents and manufactures a settlement history for both.',
          'We think it is the most interesting check we offer, and it is the least used by a wide margin.',
          'There is a plausible innocent reason. A buyer already knows who it is, so asking about itself feels redundant, and the value of the two-sided view is not obvious until someone explains what it catches. That is a documentation failure on our side rather than a demand signal.',
          'There is also a less comfortable reading, and we cannot distinguish them from this data: the agents doing the checking are not yet worried about being on the wrong side of a manufactured reputation, because the ecosystem is small enough that nobody has been burned yet. If that is the reason, it changes as soon as the first person is.',
        ],
      },
      {
        heading: 'What the data cannot tell you',
        body: [
          'We should be clear about the limits of this, because a small dataset presented confidently is how bad analysis starts.',
          'A meaningful share of these calls are seeded usage rather than organic third-party demand, and the proof page marks which are which. Buyer diversity is low. Nothing here says anything about how the mix changes at a thousand calls a day, or at prices ten times higher, or on a chain with different fee dynamics.',
          'What it does establish is narrower and still worth having: agents can and do pay per call for a trust check, the plumbing works end to end on mainnet, and the demand mix across check types is flatter than a price-driven model would predict.',
        ],
      },
      {
        heading: 'The number we are not showing you',
        body: [
          'Our public policy counters read zero. Not a small number, zero.',
          'They count decisions the guardrail engine has made for live third-party agents in production, and no live agent has produced one yet. The engine is real and enforcing, but nothing honest has passed through it, so the counter says nothing.',
          'We publish that zero on the same page as the 120. It would be easy to fill it with demo traffic, and every incentive points that way. But a number you cannot reproduce is worth less than an absence you can trust, and the whole product is a claim about verifiable trust. Padding our own metrics would be the first thing a careful reader should hold against us.',
        ],
      },
      {
        heading: 'Check it yourself',
        body: [
          'Every settlement in this post is listed at /proof with its transaction hash, and each one resolves on a public explorer. The scoring method behind the tools is published in full at /methodology, and it is deterministic, so you can recompute any score we have ever returned.',
          'If you find something in that data we got wrong, we would genuinely like to know. Being checked is the point.',
        ],
      },
    ],
    tr: {
      title: '120 gerçek ajan-ajana ödeme aslında nasıl görünüyor',
      excerpt:
        'Ajan ödemeleri hakkında yazılanların neredeyse tamamı bir öngörü. Bu değil. Güven oracle\'ımızın mainnet üzerinde gerçekten aldığı 120 settlement\'ın şekli, dağılımın ajanların nasıl satın aldığı hakkında söyledikleri ve bizi şaşırtan rakamlar.',
      chain: 'Veri',
      readingTime: '6 dakika',
      sections: [
        {
          heading: 'Bunu yazmaya neden değer',
          body: [
            'Ajan ödemeleri literatürü neredeyse tamamen ileriye dönük. Pazar büyüklüğü tahminleri, protokol açıklamaları, nasıl çalışacağına dair şemalar. Çok azı gerçekleşmiş işlemleri anlatıyor.',
            'Biz, ajanların birbirini kontrol etmek için çağrı başına ödeme yaptığı bir güven oracle\'ı işletiyoruz. X Layer mainnet üzerinde, gerçek USD₮0 ile, toplam 0,528 dolar tutarında 120 settlement aldı. Her biri işlem özetiyle listeleniyor ve isteyen herkes bu kümeyi bağımsız olarak doğrulayabilir.',
            'Küçük bir veri kümesi ve aksini iddia etmeyeceğiz. Ama gerçek bir küme ve gerçekleşmiş 120 ödemeden öğrenilecek şey, gerçekleşmemiş bir milyarın tahmininden fazladır.',
          ],
        },
        {
          heading: 'Talebin şekli',
          body: [
            '120 çağrı boyunca yedi araçtan beşi satın alındı. Dağılım şöyle:',
            'verify_agent, 32 çağrı, yüzde 27. reputation_score, 29 çağrı, yüzde 24. risk_check, 28 çağrı, yüzde 23. agent_passport, 25 çağrı, yüzde 21. counterparty_check, 6 çağrı, yüzde 5.',
            'İlk dikkat çeken şey ilk dördünün ne kadar düz olduğu. En ucuz çağrının baskın olmasını bekliyorduk, çünkü verify_agent, agent_passport\'un onda biri fiyatına. Öyle olmadı. Dördü birbirinden altı puan içinde duruyor, bu da alıcıların fiyata göre değil ihtiyaca göre seçtiğini düşündürüyor.',
          ],
        },
        {
          heading: 'Sürpriz: fiyat neredeyse hiçbir şeyi yönlendirmedi',
          body: [
            'Fiyatlarımız 0,001 dolardan 0,01 dolara, on kat aralığa yayılıyor. Ajanlar bu ölçekte maliyete duyarlı olsaydı, dağılım ağırlıklı olarak ucuz uca kayardı. Kaymadı: 0,01 dolarlık pasaport çağrıların yüzde 21\'ini aldı, 0,001 dolarlık kimlik kontrolünün yüzde 27\'sine neredeyse eşit.',
            'Ortalama settlement 0,0044 dolardı, yani aralığın tabanına değil ortasına yakın.',
            'Dürüst okuma şu: kuruş altı fiyatlarda maliyet bir ajan için karar değişkeni değil. Kuruşun onda biri de bir kuruş da, verilen kararın değerine kıyasla fiilen bedava, dolayısıyla ajan sorusunu cevaplayan çağrıyı seçiyor. Bu, bu pazarda fiyat üzerinden rekabet etmeyi planlayan herkes için rahatsız edici bir sonuç doğuruyor: belli bir eşiğin altında fiyat bir kaldıraç olmaktan tamamen çıkıyor.',
          ],
        },
        {
          heading: 'Kimsenin satın almadığı araç',
          body: [
            'counterparty_check 6 çağrı aldı, toplamın yüzde 5\'i. Önerilen bir anlaşmanın iki tarafını birden inceleyen tek araç ve tek bir varlığın iki ajanı da işletip ikisi için settlement geçmişi imal ettiği durumu, yani kendi kendine ticareti tespit edebilen tek araç.',
            'Sunduğumuz en ilginç kontrolün bu olduğunu düşünüyoruz ve açık ara en az kullanılanı.',
            'Masum bir açıklaması olabilir. Alıcı zaten kim olduğunu biliyor, dolayısıyla kendisi hakkında soru sormak gereksiz hissettiriyor ve iki taraflı bakışın değeri, birisi neyi yakaladığını anlatana kadar aşikâr değil. Bu bir talep sinyali değil, bizim tarafımızda bir dokümantasyon eksikliği.',
            'Bir de daha rahatsız edici bir okuma var ve bu veriyle ikisini ayırt edemiyoruz: kontrol yapan ajanlar, imal edilmiş bir itibarın yanlış tarafında kalmaktan henüz endişe etmiyor olabilir, çünkü ekosistem henüz kimsenin canının yanmadığı kadar küçük. Sebep buysa, ilk kişinin canı yandığı anda değişecek.',
          ],
        },
        {
          heading: 'Bu verinin size söyleyemeyeceği şeyler',
          body: [
            'Bunun sınırları konusunda açık olmalıyız, çünkü küçük bir veri kümesini kendinden emin sunmak kötü analizin başlangıcıdır.',
            'Bu çağrıların kayda değer bir kısmı organik üçüncü taraf talebi değil, tohumlanmış kullanım ve kanıt sayfası hangisinin hangisi olduğunu işaretliyor. Alıcı çeşitliliği düşük. Buradaki hiçbir şey, günde bin çağrıda, on kat yüksek fiyatlarda ya da farklı ücret dinamiklerine sahip bir zincirde dağılımın nasıl değişeceği hakkında bir şey söylemiyor.',
            'Ortaya koyduğu şey daha dar ama yine de değerli: ajanlar bir güven kontrolü için çağrı başına ödeme yapabiliyor ve yapıyor, tesisat mainnet üzerinde uçtan uca çalışıyor ve kontrol türleri arasındaki talep dağılımı, fiyat odaklı bir modelin öngöreceğinden daha düz.',
          ],
        },
        {
          heading: 'Size göstermediğimiz sayı',
          body: [
            'Kamuya açık politika sayaçlarımız sıfır gösteriyor. Küçük bir sayı değil, sıfır.',
            'Bu sayaçlar, korkuluk motorunun canlı üçüncü taraf ajanlar için üretimde verdiği kararları sayıyor ve henüz hiçbir canlı ajan böyle bir karar üretmedi. Motor gerçek ve uyguluyor, ama içinden dürüstçe sayılabilecek bir şey geçmedi, dolayısıyla sayaç hiçbir şey söylemiyor.',
            'Bu sıfırı, 120 ile aynı sayfada yayınlıyoruz. Demo trafiğiyle doldurmak kolay olurdu ve bütün teşvikler o yöne işaret ediyor. Ama yeniden üretemediğiniz bir sayı, güvenebildiğiniz bir yokluktan daha değersizdir ve ürünün tamamı doğrulanabilir güven üzerine bir iddia. Kendi metriklerimizi şişirmek, dikkatli bir okuyucunun bize karşı tutması gereken ilk şey olurdu.',
          ],
        },
        {
          heading: 'Kendiniz kontrol edin',
          body: [
            'Bu yazıdaki her settlement /proof adresinde işlem özetiyle listeleniyor ve her biri herkese açık bir gezginde çözümleniyor. Araçların arkasındaki skorlama yöntemi /methodology adresinde tamamıyla yayında ve deterministik, dolayısıyla şimdiye kadar döndürdüğümüz herhangi bir skoru yeniden hesaplayabilirsiniz.',
            'O veride yanlış yaptığımız bir şey bulursanız gerçekten bilmek isteriz. Kontrol edilmek zaten amacın kendisi.',
          ],
        },
      ],
    },
  },
  {
    slug: 'two-kinds-of-agent-budget',
    title: 'Your agent has two budgets, and only one of them is money',
    excerpt:
      'Search for how to give an AI agent a budget and you get two completely different answers, both called the same thing. One is about tokens. The other is about your bank balance. Conflating them is how teams end up protected against the cheap failure and exposed to the expensive one.',
    chain: 'Guardrails',
    accent: '#8A4A3C',
    date: 'Jul 31, 2026',
    readingTime: '6 min read',
    seed: 12,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'Two questions wearing the same words',
        body: [
          'Ask the internet how to stop an AI agent burning through your budget and you get a confident answer. Read a few of them and you notice they are not answering the same question.',
          'One set is about inference cost: token caps per run, model routing, an auto-pause when a task loops. The failure mode is a bill from your model provider.',
          'The other is about payments: the agent has a wallet or a card and can move real value to a third party. The failure mode is money leaving your account and not coming back.',
          'Both get called "agent budget" and "spend controls". They are not the same problem, they do not fail the same way, and the controls for one do almost nothing for the other.',
        ],
      },
      {
        heading: 'Why the difference is not academic',
        body: [
          'Token overspend is bounded, observable and reversible in the ways that matter. The bill arrives at the end of the month, your provider shows you a dashboard, and the worst case is a number you did not plan for. Unpleasant, survivable.',
          'Payment overspend is none of those things. It is unbounded until something stops it, it is often invisible until reconciliation, and once a stablecoin transfer settles there is no chargeback, no dispute window and no support line. The counterparty has the money.',
          'So a team that reads the token-cost articles, sets a per-run cap, and concludes it has solved agent spending has protected itself against the recoverable failure while leaving the unrecoverable one wide open.',
        ],
      },
      {
        heading: 'What a real payment limit has to survive',
        body: [
          'A token cap lives in your own orchestration code and that is fine, because the thing it is protecting against is your own code looping. A payment limit has a harder job: it has to hold against an agent that is actively trying to get past it.',
          'That is not a hypothetical. A language model is a persuasion engine. Put the limit in the prompt and you have written a suggestion. Put it in a wrapper the agent calls and you have written a suggestion with an extra step, because the agent decides whether to call it.',
          'The test for any payment control is simple: if the agent were adversarial, would this still hold? Most guardrails fail that question immediately.',
        ],
      },
      {
        heading: 'The four ways a limit leaks',
        body: [
          'The first is the obvious one, an agent that simply asks for more than it should. Every control catches this and it is the least interesting case.',
          'The second is the path nobody instrumented. A team blocks purchases and forgets recurring payments, or blocks transfers and forgets that cancelling a protective position is also a way to lose money. Guardrails that cover the main verb and miss the adjacent ones are the normal failure, not the exception.',
          'The third is the retry. An agent told no does not always stop; it rephrases and tries again. If refusals are not counted, a limit that says no ninety times and yes once has said yes.',
          'The fourth is the one that looks like success: the agent stays under every per-transaction cap and makes forty of them. Any control without a time window is not a budget, it is a transaction size limit.',
        ],
      },
      {
        heading: 'Where the number should actually live',
        body: [
          'The useful mental model is to ask what has to be true for the limit to fail, and then make that thing harder.',
          'A limit in a prompt fails if the agent is persuaded. A limit in your server fails if your server is wrong, compromised, or simply down at the moment it matters. A limit in a contract on-chain fails if the contract is wrong, which is a much smaller and much more auditable surface.',
          'None of these is sufficient alone, which is why the answer is layers rather than a choice. The server pre-check is the fast path and handles the common case. The on-chain vault reverts an over-limit transfer regardless of what anything upstream believed. Wallet-layer screening at the custody provider catches what neither saw.',
          'An agent can talk its way past one of those. Talking a contract into ignoring its own require statement is not a thing that happens.',
        ],
      },
      {
        heading: 'The signal most systems throw away',
        body: [
          'Almost every guardrail design has two outcomes: allow and block. Real spending decisions have three.',
          'The missing one is the case where the payment is permitted but large enough, or unusual enough, that a person should see it before it happens. Collapse that into allow and you have a system that silently approves the payments you most wanted to know about. Collapse it into block and people turn the whole thing off within a week because it keeps stopping legitimate work.',
          'Naming it explicitly, as WARN, is what makes the difference. It escalates rather than deciding, and the human in the loop is asked a specific question at a specific moment instead of being handed a dashboard to monitor.',
        ],
      },
      {
        heading: 'Set both, but know which is which',
        body: [
          'None of this argues against token budgets. Cap your per-run inference cost, route to cheaper models where you can, and pause a task that loops. That work is real and the articles about it are good.',
          'Just do not file it under the same heading as payment authority, and do not let a green dashboard on one imply safety on the other. Ask which budget a given control protects, and be honest when the answer is "the cheap one".',
          'The agent that runs up a large inference bill has cost you money. The agent that pays the wrong counterparty has given your money to someone else. Only one of those is a support ticket.',
        ],
      },
    ],
    tr: {
      title: 'Ajanınızın iki bütçesi var ve sadece biri para',
      excerpt:
        'Bir AI ajanına nasıl bütçe verilir diye arattığınızda birbirinden tamamen farklı iki cevap alırsınız ve ikisinin de adı aynıdır. Biri token hakkında. Diğeri banka bakiyeniz hakkında. İkisini karıştırmak, ekiplerin ucuz hataya karşı korunup pahalı hataya açık kalmasının yoludur.',
      chain: 'Korkuluklar',
      readingTime: '6 dakika',
      sections: [
        {
          heading: 'Aynı kelimeleri giyen iki soru',
          body: [
            'İnternete bir AI ajanının bütçenizi tüketmesini nasıl engelleyeceğinizi sorun, kendinden emin bir cevap alırsınız. Birkaç tanesini okuyunca aynı soruyu cevaplamadıklarını fark edersiniz.',
            'Bir grup çıkarım maliyetinden bahsediyor: çalışma başına token sınırı, model yönlendirme, döngüye giren bir görevi durduran otomatik duraklatma. Buradaki hata modu, model sağlayıcınızdan gelen faturadır.',
            'Diğer grup ödemelerden bahsediyor: ajanın bir cüzdanı veya kartı var ve üçüncü bir tarafa gerçek değer aktarabiliyor. Buradaki hata modu, paranın hesabınızdan çıkması ve geri gelmemesidir.',
            'İkisine de "ajan bütçesi" ve "harcama kontrolü" deniyor. Aynı problem değiller, aynı şekilde bozulmuyorlar ve birinin kontrolleri diğeri için neredeyse hiçbir şey yapmıyor.',
          ],
        },
        {
          heading: 'Fark neden teorik değil',
          body: [
            'Token aşımı sınırlı, gözlemlenebilir ve önemli anlamda telafi edilebilir. Fatura ay sonunda gelir, sağlayıcınız size bir gösterge paneli sunar ve en kötü ihtimalle planlamadığınız bir sayıyla karşılaşırsınız. Can sıkıcı ama atlatılır.',
            'Ödeme aşımı bunların hiçbiri değildir. Bir şey durdurana kadar sınırsızdır, çoğu zaman mutabakat anına kadar görünmezdir ve bir stablecoin transferi bir kez gerçekleştikten sonra ne ters ibraz, ne itiraz süresi, ne de arayacağınız bir destek hattı vardır. Para karşı taraftadır.',
            'Dolayısıyla token maliyeti yazılarını okuyup çalışma başına bir sınır koyan ve ajan harcamasını çözdüğünü düşünen bir ekip, kendini telafi edilebilir hataya karşı korumuş, telafi edilemez olanı ardına kadar açık bırakmıştır.',
          ],
        },
        {
          heading: 'Gerçek bir ödeme limitinin dayanması gereken şey',
          body: [
            'Token sınırı kendi orkestrasyon kodunuzda yaşar ve bu sorun değildir, çünkü koruduğu şey kendi kodunuzun döngüye girmesidir. Ödeme limitinin işi daha zordur: aktif olarak kendisini aşmaya çalışan bir ajana karşı dayanması gerekir.',
            'Bu varsayımsal değil. Bir dil modeli ikna makinesidir. Limiti isteme koyarsanız bir öneri yazmış olursunuz. Ajanın çağırdığı bir sarmalayıcıya koyarsanız, araya bir adım eklenmiş bir öneri yazmış olursunuz, çünkü onu çağırıp çağırmamaya ajan karar verir.',
            'Herhangi bir ödeme kontrolünün testi basittir: ajan düşmanca davransaydı bu yine dayanır mıydı? Çoğu korkuluk bu soruda anında düşer.',
          ],
        },
        {
          heading: 'Bir limitin sızdırdığı dört yol',
          body: [
            'Birincisi bariz olanı, olması gerekenden fazlasını isteyen ajan. Her kontrol bunu yakalar ve bu en az ilginç durumdur.',
            'İkincisi, kimsenin ölçmediği yol. Ekip satın almaları engeller ama düzenli ödemeleri unutur, ya da transferleri engeller ama koruyucu bir pozisyonu iptal etmenin de para kaybetmenin bir yolu olduğunu gözden kaçırır. Ana fiili kapsayıp yanındakileri atlayan korkuluklar istisna değil, normal hatadır.',
            'Üçüncüsü tekrar denemedir. Hayır denen bir ajan her zaman durmaz; cümleyi değiştirip yeniden dener. Retler sayılmıyorsa, doksan kez hayır bir kez evet diyen bir limit evet demiştir.',
            'Dördüncüsü başarı gibi görünendir: ajan işlem başına her sınırın altında kalır ve kırk işlem yapar. Zaman penceresi olmayan bir kontrol bütçe değildir, işlem büyüklüğü sınırıdır.',
          ],
        },
        {
          heading: 'Sayının gerçekte nerede durması gerekir',
          body: [
            'İşe yarayan düşünme biçimi şudur: limitin bozulması için neyin doğru olması gerektiğini sorun, sonra o şeyi zorlaştırın.',
            'İstemdeki bir limit, ajan ikna edilirse bozulur. Sunucunuzdaki bir limit, sunucunuz yanılırsa, ele geçirilirse ya da tam o anda ayakta değilse bozulur. Zincir üstündeki bir sözleşmedeki limit, sözleşme yanlışsa bozulur ki bu çok daha küçük ve çok daha denetlenebilir bir yüzeydir.',
            'Bunların hiçbiri tek başına yeterli değil, bu yüzden cevap seçim değil katmanlardır. Sunucu ön kontrolü hızlı yoldur ve sıradan durumu halleder. Zincir üstü kasa, yukarıdaki hiçbir katmanın neye inandığından bağımsız olarak limit aşan transferi geri çevirir. Saklama sağlayıcısındaki cüzdan taraması, ikisinin de görmediğini yakalar.',
            'Bir ajan bunlardan birini konuşarak aşabilir. Bir sözleşmeyi kendi require satırını görmezden gelmeye ikna etmek diye bir şey yoktur.',
          ],
        },
        {
          heading: 'Çoğu sistemin çöpe attığı sinyal',
          body: [
            'Neredeyse her korkuluk tasarımının iki sonucu vardır: izin ver ve engelle. Gerçek harcama kararlarının üç tane vardır.',
            'Eksik olan, ödemenin izinli olduğu ama bir insanın gerçekleşmeden önce görmesi gerekecek kadar büyük ya da olağandışı olduğu durumdur. Bunu "izin ver" içine katarsanız, en çok haberdar olmak istediğiniz ödemeleri sessizce onaylayan bir sistem kurmuş olursunuz. "Engelle" içine katarsanız, meşru işi sürekli durdurduğu için insanlar bir hafta içinde her şeyi kapatır.',
            'Bunu WARN olarak açıkça adlandırmak farkı yaratan şeydir. Karar vermek yerine yukarı taşır ve döngüdeki insana, izlemesi için bir gösterge paneli vermek yerine belirli bir anda belirli bir soru sorulur.',
          ],
        },
        {
          heading: 'İkisini de koyun, ama hangisinin hangisi olduğunu bilin',
          body: [
            'Bunların hiçbiri token bütçelerine karşı bir argüman değil. Çalışma başına çıkarım maliyetinizi sınırlayın, yapabildiğiniz yerde daha ucuz modellere yönlendirin ve döngüye giren görevi duraklatın. Bu iş gerçek ve hakkında yazılanlar iyi.',
            'Sadece bunu ödeme yetkisiyle aynı başlık altına koymayın ve birinde yeşil yanan bir panelin diğerinde güvenlik anlamına geldiğini düşünmeyin. Belirli bir kontrolün hangi bütçeyi koruduğunu sorun ve cevap "ucuz olanı" olduğunda dürüst olun.',
            'Büyük bir çıkarım faturası çıkaran ajan size paraya mal olmuştur. Yanlış karşı tarafa ödeme yapan ajan, paranızı başkasına vermiştir. Bunlardan sadece biri bir destek talebidir.',
          ],
        },
      ],
    },
  },
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
