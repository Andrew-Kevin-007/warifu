import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageFrame, Section } from '@/components/product/PageFrame';
import { ReceiptVerifier } from '@/components/audit/ReceiptVerifier';

export const metadata: Metadata = { title: 'Verify a receipt | Symbolon', description: 'Recompute a receipt hash, recover its signer and check the on-chain release in your own browser.' };

export default async function Page({ params }: { params: Promise<{ receiptHash: string }> }) {
  const { receiptHash } = await params;
  const hash = receiptHash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) notFound();
  const rpc = process.env.NEXT_PUBLIC_ARC_RPC_URL ?? null;
  return (
    <PageFrame
      eyebrow="Receipt verifier"
      title="Verify this receipt yourself"
      lede="Your browser recomputes the receipt hash, recovers the signer, reads the kernel signer from the vault over a public RPC and looks for the Released event. This server only supplies the receipt bytes; its answers are not trusted."
    >
      <Section title="Receipt hash">
        <p className="sy-mono">{hash}</p>
      </Section>
      <Section title="Verification">
        <ReceiptVerifier hash={hash} rpcUrl={rpc} />
      </Section>
      <Section title="Command line">
        <pre className="sy-pre">{`pnpm verify-receipt ${hash} --vault <vault address> --rpc <your-own-rpc-url>`}</pre>
        <p className="body-text-s">Exit code 0 means verified, 1 not verified, 2 usage or input error.</p>
      </Section>
    </PageFrame>
  );
}
