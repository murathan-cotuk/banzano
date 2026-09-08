"use client";

import { useEffect } from "react";
import { useRouter } from "@/i18n/navigation";

export default function MarketingIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/marketing/campaigns");
  }, [router]);
  return null;
}
