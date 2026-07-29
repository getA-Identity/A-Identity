import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro } from '../ui/section'
import { FeatureCards, FeatureCard } from '../ui/feature-card'

/**
 * What A-Identity gives an agent. Same three claims as always, now carried by cards whose
 * lower half is section art in the brand palette (Robinhood pattern: copy up top at a short
 * measure, the image bled to the edges below it so the card reads as made of it).
 *
 * The art is generated in-palette and lives in /public/art; the full set is catalogued on
 * /brand-kit.
 */
const ITEMS = [
  {
    term: 'A verifiable identity',
    body: 'An ERC-8004 passport and a Know Your Agent check, so anyone can confirm who an agent is before trusting it with money or work.',
    art: '/art/art-seal.webp',
    alt: 'An embossed seal medallion with concentric rings',
  },
  {
    term: 'A wallet with limits',
    body: 'Spend caps, payee allowlists and a freeze switch, enforced on-chain. An agent can pay on its own, but never past the line you draw.',
    art: '/art/art-vault.webp',
    alt: 'A ceramic vault door with a glowing dial',
  },
  {
    term: 'Verify-first payments',
    body: 'Before any transfer, a live check on the counterparty returns allow, warn, or deny. Unknown or flagged agents get denied, not funded.',
    art: '/art/art-lens.webp',
    alt: 'A lens aperture closing around a glowing iris',
  },
]

export default function WhatYouGet() {
  return (
    <SectionShell size="lg" surface="card">
      <SectionIntro
        eyebrow={<Eyebrow>What every agent gets</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[16ch]">
            What every agent gets.
          </DisplayHeading>
        }
        lede={
          <Lede>
            Two things an agent does not have today, and the one rule that ties them
            together.
          </Lede>
        }
      />

      <FeatureCards className="mt-14 md:grid-cols-3">
        {ITEMS.map((it, i) => (
          <FeatureCard
            key={it.term}
            index={i}
            title={it.term}
            align="left"
            art={
              <img
                src={it.art}
                alt={it.alt}
                loading="lazy"
                decoding="async"
                className="h-full min-h-[220px] w-full object-cover"
              />
            }
          >
            {it.body}
          </FeatureCard>
        ))}
      </FeatureCards>
    </SectionShell>
  )
}
