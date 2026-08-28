declare module "seek-bzip" {
    const bunzip: {
        decode(
            input: Uint8Array,
            output: { writeByte(value: number): void },
            multistream?: boolean,
        ): void;
    };
    export default bunzip;
}
