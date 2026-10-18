import typescript from '@rollup/plugin-typescript';
import copy from 'rollup-plugin-copy';

export default {
  input: 'src/index.ts',
  external: ['expo-file-system', 'react-native-tcp-socket', 'react-native-udp'],
  output: [
    { file: 'dist/index.cjs', format: 'cjs', sourcemap: true },
    { file: 'dist/index.es.js', format: 'es', sourcemap: true },
  ],
  plugins: [
    typescript({
      tsconfig: './tsconfig.build.json',
      declaration: true,
      declarationDir: 'dist/types',
      rootDir: 'src',
    }),
    copy({
      targets: [
        { src: 'package.json', dest: 'dist' },
        { src: 'LICENSE', dest: 'dist' },
        { src: 'README.md', dest: 'dist' },
        { src: 'SKILL.md', dest: 'dist' },
      ],
    }),
  ],
};
