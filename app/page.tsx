'use client';

import dynamic from 'next/dynamic';

// The engine touches window/WebGL at construction time, so it never renders on
// the server. Client-side `dynamic` with ssr:false is the supported escape hatch.
const Arena = dynamic(() => import('@/components/Arena'), {
  ssr: false,
  loading: () => (
    <div className="boot">
      <div className="boot__pulse" />
      <span>building the arena</span>
    </div>
  ),
});

export default function Page() {
  return <Arena />;
}
