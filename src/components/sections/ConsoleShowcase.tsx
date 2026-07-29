import { motion } from 'framer-motion'
import { ArrowRight, BadgeCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal } from '../ui/section'
import { ProductMock, MockRow, MockValue, MockToggle } from '../ui/product-mock'
import OwlMark from '../OwlMark'

/**
 * The console, shown as itself inside a frame.
 *
 * The dashx pattern: the product's actual surface presented as a large rounded card sitting
 * in its own frame, which reads as "this exists" in a way no illustration can. Ours is
 * rendered from the same tokens the real console uses rather than screenshotted, so it is
 * correct in both themes and cannot rot.
 *
 * Everything on these two mocks is a real console concept with its real vocabulary: the
 * spend permissions panel's caps and switches, and the explorer's verdict card for the
 * showcase agent. Nothing invented, nothing aspirational.
 */
export default function ConsoleShowcase() {
  return (
    <SectionShell size="lg" surface="card">
      <SectionIntro
        eyebrow={<Eyebrow>The console</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[18ch]">
            Your rules, in one place the agent cannot edit.
          </DisplayHeading>
        }
        lede={
          <Lede>
            Caps, allowlists, session keys and a freeze switch, enforced outside the model
            and mirrored on-chain. This is the actual surface, not a mockup of one.
          </Lede>
        }
      />

      {/* The frame: a soft gradient mat around an inner card, dashx-style. */}
      <motion.div
        {...reveal}
        transition={{ ...reveal.transition, delay: 0.12 }}
        className="mt-14 rounded-[2rem] border border-border bg-gradient-to-b from-foreground/[0.05] to-transparent p-2.5 shadow-[0_40px_100px_-40px_rgba(16,24,40,0.35)] sm:p-3"
      >
        <div className="grid gap-4 rounded-[1.6rem] border border-border bg-background/70 p-4 backdrop-blur-sm sm:p-6 md:grid-cols-2">
          <ProductMock title="Spend Permissions" meta="agent · translator-01 · Arc testnet">
            <MockRow label="Daily cap" sub="resets 00:00 UTC" value={<MockValue>$50.00</MockValue>} />
            <MockRow label="Auto-approve under" sub="above this, a human signs" value={<MockValue>$5.00</MockValue>} />
            <MockRow label="Payee allowlist" sub="4 addresses" value={<MockToggle on />} />
            <MockRow label="Freeze" sub="stops everything, instantly" value={<MockToggle />} />
          </ProductMock>

          <ProductMock title="Trust check" meta="explorer · live from the chain">
            <MockRow
              leading={<OwlMark verdict="allow" size={30} />}
              label="Meridian"
              sub="#849980 · KYA verified"
              value={
                <span className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs font-bold" style={{ color: '#059669', background: '#05966914' }}>
                  ALLOW
                </span>
              }
            />
            <MockRow label="Reputation" sub="settlements, validation, tenure" value={<MockValue>720 / 1000</MockValue>} />
            <MockRow
              leading={<BadgeCheck size={16} className="text-emerald-600" />}
              label="Wallet control proven"
              sub="attested in the ValidationRegistry"
            />
            <MockRow
              leading={<OwlMark verdict="deny" size={30} />}
              label="Unknown counterparty"
              sub="no on-chain identity"
              value={
                <span className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs font-bold" style={{ color: '#dc2626', background: '#dc262614' }}>
                  DENY
                </span>
              }
            />
          </ProductMock>
        </div>
      </motion.div>

      <motion.div {...reveal} className="mt-8">
        <Link
          to="/explorer"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent transition-opacity hover:opacity-80"
        >
          Open the live explorer <ArrowRight size={15} />
        </Link>
      </motion.div>
    </SectionShell>
  )
}
