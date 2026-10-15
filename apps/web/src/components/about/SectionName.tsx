import { BRAND } from '@/lib/brand';

/** The name, once, with its kanji and an accurate gloss; plus the one allowed "formerly" footnote (docs/BRAND_AND_IDEA.md). */
export default function SectionName() {
  return (
    <section className="sy-page" id="the-name">
      <div className="sy-wrap">
        <h2 className="heading-h5">
          The name: {BRAND.name} ({BRAND.kanji})
        </h2>
        <p className="body-text-m">
          A <em>warifu</em> (pronounced &ldquo;{BRAND.reading}&rdquo;) is a split tally: a token broken in two so that only the two matching halves
          prove the agreement. In medieval Japan the same device was used as a merchant&apos;s bill of exchange. The idea is the same as the Greek
          symbolon: a payment proposal and a signed engagement either fit or they do not. When they do not fit, nothing is released.
        </p>
        <p className="body-text-s">
          {BRAND.name} (formerly {BRAND.formerName}). Package names, spec identifiers and the signing domain keep their original names so existing
          signatures and test vectors stay valid.
        </p>
      </div>
    </section>
  );
}
