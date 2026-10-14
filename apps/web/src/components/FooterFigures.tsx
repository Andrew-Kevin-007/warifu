'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { BallCollider, Physics, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import * as THREE from 'three';

const COUNT = 15;
const SCALE = 1;

function Tetrapod({ index }: { index: number }) {
  const body = useRef<RapierRigidBody>(null);
  const vec = useMemo(() => new THREE.Vector3(), []);
  const { nodes } = useGLTF('/tetrapod_v1.glb') as unknown as {
    nodes: { Cylinder004: THREE.Mesh };
  };
  const geometry = useMemo(() => nodes.Cylinder004.geometry.clone(), [nodes]);
  const material = useMemo(
    () => new THREE.MeshMatcapMaterial({ matcap: new THREE.TextureLoader().load('/matcap.png') }),
    [],
  );
  const target = useMemo(() => new THREE.Vector3(THREE.MathUtils.lerp(-7, 7, index / COUNT), 0, 0), [index]);
  const start = useMemo(
    () =>
      [
        THREE.MathUtils.randFloatSpread(10),
        THREE.MathUtils.randFloatSpread(10) - 5,
        THREE.MathUtils.randFloatSpread(1),
      ] as [number, number, number],
    [],
  );

  useFrame((_, delta) => {
    const rb = body.current;
    if (!rb) return;
    const dt = Math.min(0.1, delta);
    let k = 10;
    if (rb.translation().y < 0) k = 1;
    const r = vec.copy(rb.translation() as THREE.Vector3).sub(target);
    const len = r.length();
    rb.applyImpulse(
      r
        .normalize()
        .multiplyScalar(0.1 * len)
        .multiply({ x: -20 * dt * SCALE, y: -150 * dt * SCALE * k, z: -30 * dt * SCALE } as THREE.Vector3),
      true,
    );
  });

  return (
    <RigidBody
      ref={body}
      linearDamping={1.95}
      angularDamping={4}
      mass={1000}
      friction={0.9}
      position={start}
      colliders="hull"
    >
      <mesh castShadow receiveShadow scale={SCALE} geometry={geometry} material={material} />
    </RigidBody>
  );
}

// Invisible kinematic ball that follows the pointer and shoves the pieces around.
function Pointer() {
  const body = useRef<RapierRigidBody>(null);
  const vec = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ pointer, viewport }) => {
    vec.lerp({ x: (pointer.x * viewport.width) / 2, y: (pointer.y * viewport.height) / 2, z: 0 } as THREE.Vector3, 0.2);
    body.current?.setNextKinematicTranslation(vec);
  });
  return (
    <RigidBody position={[100, 100, 100]} type="kinematicPosition" ref={body} mass={1} friction={0.9} colliders="ball">
      <BallCollider args={[0.5]} restitution={-10} />
    </RigidBody>
  );
}

export default function FooterFigures() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const go = () => setReady(true);
    if (document.readyState !== 'complete') {
      window.addEventListener('load', go);
      return () => window.removeEventListener('load', go);
    }
    go();
  }, []);

  if (!ready) return null;

  return (
    <Canvas
      orthographic
      camera={{ zoom: 70, near: -100, far: 100 }}
      gl={{ alpha: true, stencil: true, depth: true, antialias: false }}
      shadows
    >
      <ambientLight intensity={1} />
      <spotLight position={[20, 20, 25]} penumbra={1} angle={0.2} color="white" castShadow shadow-mapSize={[512, 512]} />
      <directionalLight position={[0, 5, -4]} intensity={4} />
      <directionalLight position={[0, -15, 0]} intensity={4} color="red" />
      <Physics gravity={[0, 0, 0]} colliders={false}>
        <Pointer />
        {Array.from({ length: COUNT }, (_, i) => (
          <Tetrapod key={i} index={i} />
        ))}
        <RigidBody type="fixed" position-z={2.2} rotation={[0, 0, 0]}>
          <mesh receiveShadow>
            <boxGeometry args={[100, 100, 0.1, 50, 50, 50]} />
            <meshStandardMaterial color="gray" wireframe visible={false} />
          </mesh>
        </RigidBody>
      </Physics>
    </Canvas>
  );
}

useGLTF.preload('/tetrapod_v1.glb');
