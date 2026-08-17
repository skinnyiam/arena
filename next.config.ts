import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The engine owns a single WebGL context and disposes it on unmount.
  // StrictMode's double-invoked effects would build the arena twice in dev,
  // which is wasteful (~1s of geometry work) even though cleanup is correct.
  reactStrictMode: false,
};

export default nextConfig;
