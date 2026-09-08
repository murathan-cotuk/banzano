"use client";

import { useEffect } from "react";
import { useRouter } from "@/i18n/navigation";

export default function AnalyticsIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/analytics/reports");
  }, [router]);
  return null;
}
