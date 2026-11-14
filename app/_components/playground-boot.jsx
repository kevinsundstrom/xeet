"use client";

import { useEffect } from "react";
import { bootPlayground } from "../_lib/boot-playground.js";

export default function PlaygroundBoot() {
  useEffect(() => {
    bootPlayground();
  }, []);
  return null;
}
