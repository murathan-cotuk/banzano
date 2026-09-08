"use client";

import { useEffect } from "react";
import { useRouter } from "@/i18n/navigation";

export default function Profile() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/general");
  }, [router]);
  return null;
}

