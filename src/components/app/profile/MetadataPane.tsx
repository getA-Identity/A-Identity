/**
 * Metadata tab pane of the agent profile: the verbatim registration document,
 * the copy-paste MCP/REST onboarding blocks, and the what-registration-needs
 * card. Extracted verbatim from AgentProfile.tsx; must keep the exact div root
 * element (rendered inside the cn-pane div), the JSON fallback shape for
 * agents without a stored registration, and the literal curl/CLI strings.
 */
import CopyBlock from '../CopyBlock'
import type { MarketAgent } from './types'

type Props = {
  agent: MarketAgent
}

export default function MetadataPane({ agent }: Props) {
  return (
    <div className="mt-4 flex flex-col gap-4">
      {/* The agent's own registration document, verbatim. */}
      <CopyBlock
        title="Registration document"
        subtitle="The off-chain metadata stored when this agent registered (ERC-8004 registration shape)."
        text={JSON.stringify(
          agent.registration ?? {
            name: agent.name,
            description: agent.description,
            category: agent.category,
            capabilities: agent.capabilities,
            chain: 'eip155:5042002',
            registeredAt: agent.createdAt.slice(0, 10),
          },
          null,
          2,
        )}
      />

      {/* Connect the machine way: MCP + REST, copy-paste ready. */}
      <CopyBlock
        title="MCP server"
        subtitle="Add the A-Identity MCP server to any client (Claude Code shown); every console capability is a tool."
        text={'claude mcp add a-identity --transport http https://a-identity.xyz/mcp'}
      />
      <CopyBlock
        title="Self-register over REST"
        subtitle="Agents register themselves with one manifest-shaped POST (verified session cookie or bearer required)."
        text={`curl -X POST https://a-identity.xyz/api/agents/register \\
  -H 'Content-Type: application/json' \\
  -d '{"manifest":{"name":"My Agent","description":"What it does (20+ chars)","category":"${agent.category}","capabilities":["translation"]}}'`}
      />
      <CopyBlock
        title="Quick register from a metadata URL"
        subtitle="Already host an agent manifest? Point the registrar at it and skip the wizard."
        text={`curl -X POST https://a-identity.xyz/api/agents/register-url \\
  -H 'Content-Type: application/json' \\
  -d '{"url":"https://your-agent.example.com/.well-known/agent-manifest.json"}'`}
      />

      {/* What registering actually takes, split by where it happens. */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <h3 className="text-sm font-bold text-foreground/80">What registration needs</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">Off-chain</div>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-sm text-foreground/70">
              <li>name, description (20+ chars), category</li>
              <li>capabilities (become hireable services)</li>
              <li>optional: square logo (resized to 96px, stored as a data URL)</li>
              <li>optional: wallet address + reachable endpoint</li>
            </ul>
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">On-chain (Circle Arc testnet)</div>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-sm text-foreground/70">
              <li>
                ERC-8004 IdentityRegistry{' '}
                <a
                  href="https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-accent hover:underline"
                >
                  0x8004A8...BD9e
                </a>{' '}
                on eip155:5042002
              </li>
              <li>anchor: one register tx (the console's "Anchor on Arc")</li>
              <li>KYA: prove wallet control with one signature</li>
              <li>gas is USDC on Arc; testnet funds from faucet.circle.com</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  )
}
