'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { waveFragmentShader, waveVertexShader } from '@/lib/waveShaders';

// The soft purple cloud behind the hero figures: a displaced plane with a depth/surface colour mix.
export default function HeroWave() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const white = '#ffffff';
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(white, 1, 3);
    scene.background = new THREE.Color(white);

    const geometry = new THREE.PlaneGeometry(12, 12, 512, 512);
    const material = new THREE.ShaderMaterial({
      vertexShader: waveVertexShader,
      fragmentShader: waveFragmentShader,
      transparent: true,
      fog: true,
      uniforms: {
        uTime: { value: 0 },
        uMouse: { value: new THREE.Vector2() },
        uBigWavesElevation: { value: 0.214 },
        uBigWavesFrequency: { value: new THREE.Vector2(2.448, 2.136) },
        uBigWaveSpeed: { value: 1.598 },
        uSmallWavesElevation: { value: 0.195 },
        uSmallWavesFrequency: { value: 0 },
        uSmallWavesSpeed: { value: 0.323 },
        uSmallWavesIterations: { value: 0 },
        uDepthColor: { value: new THREE.Color('#d5abff') },
        uSurfaceColor: { value: new THREE.Color('#9280fc') },
        uColorOffset: { value: 0.0893 },
        uColorMultiplier: { value: 2.735 },
        ...THREE.UniformsLib.fog,
      },
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -(0.5 * Math.PI);
    scene.add(mesh);

    const camera = new THREE.PerspectiveCamera(75, 2.25, 0.1, 100);
    camera.position.set(1, 1.4, 1);
    camera.lookAt(0, 0, 0);
    scene.add(camera);

    const renderer = new THREE.WebGLRenderer({ canvas });
    renderer.setSize(1800, 800);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      material.uniforms.uTime.value = clock.getElapsedTime();
      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(tick);
    };
    tick();

    return () => {
      window.cancelAnimationFrame(raf);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, []);

  return <canvas ref={ref} className="webgl" />;
}
