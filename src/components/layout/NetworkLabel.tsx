import { useState } from "react";

export function NetworkLabel({ name, logo }: { name: string; logo?: string }) {
  const [failedLogo, setFailedLogo] = useState<string>();
  return (
    <span className="obby-server-name">
      {logo && failedLogo !== logo ? (
        <>
          <img
            src={logo}
            alt=""
            className="obby-network-wordmark"
            draggable={false}
            onError={() => setFailedLogo(logo)}
          />
          <span className="sr-only">{name}</span>
        </>
      ) : (
        name
      )}
    </span>
  );
}
