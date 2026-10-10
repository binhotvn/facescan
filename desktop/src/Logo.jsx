import React from 'react';

/** Kapok mark: the five-petal kapok (hoa gạo) flower. Placeholder until the
 * brand's own logo arrives; the app icon is drawn from the same shape. */
export default function Logo({ size = 28 }) {
  const petals = [0, 72, 144, 216, 288];
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#D6452F" />
      <g transform="translate(32 33)">
        {petals.map((a) => (
          <ellipse key={a} cx="0" cy="-12" rx="7.5" ry="12" fill="#fff" transform={`rotate(${a})`} />
        ))}
        <circle r="5.5" fill="#D6452F" />
        <circle r="2.5" fill="#ffd27a" />
      </g>
    </svg>
  );
}
